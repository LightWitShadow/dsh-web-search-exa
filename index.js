/**
 * DSH web search provider backed by Exa's official hosted MCP endpoint.
 *
 * The provider implements the `ctx.web` search seam (`registerSearchProvider`),
 * so the built-in `web_search` tool calls Exa directly. Authentication follows
 * Exa's official keyless channel: the hosted MCP server (https://mcp.exa.ai/mcp)
 * works anonymously with rate limits. Higher limits are available later by
 * pointing `url` at `...?login` (OAuth) or `...?exaApiKey=...` — that choice
 * and any credential stay entirely with the user, in the plugin row config.
 *
 * This module is intentionally dependency-free (no bare imports): it is
 * installed via a pnpm link into a profile whose node_modules does not carry
 * the dsh package tree, so Node could not resolve them from the link target.
 * Everything the plugin needs from the host arrives through the live context:
 * the `ctx.web` service instance (the true singleton) and a plain config
 * object (no Schemastery schema; defaults are applied in code). The local
 * WebError mirrors dsh-llm's HarnessError shape (`message`, `code`, `cause`),
 * which consumers route by `code`, not by class identity.
 *
 * Transport is MCP streamable-http spoken with plain `fetch`: initialize →
 * notifications/initialized → tools/call. The session id is cached per
 * provider instance and re-established once when the server reports it stale.
 *
 * @module @local/dsh-web-search-exa
 */

/** Cordis plugin name used by loader diagnostics. */
const name = "web-search-exa";
/** The web seam this provider registers into. */
const inject = ["web"];
/** Stable id this provider registers under; select with `searchProvider: exa`. */
const EXA_PROVIDER_ID = "exa";
/** Exa's official hosted MCP endpoint; anonymous with rate limits. */
const DEFAULT_URL = "https://mcp.exa.ai/mcp";
/** Default MCP tool name on Exa's hosted server. */
const DEFAULT_TOOL = "web_search_exa";
/** Default number of results requested per search. */
const DEFAULT_NUM_RESULTS = 10;
/** Default whole-search timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 45000;
/** Per-result snippet cap; Exa highlights can be long and the seam has no cap. */
const SNIPPET_MAX_CHARS = 2000;
/** MCP protocol version this client speaks during initialize. */
const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * WebError-shaped provider error (message, machine-routable `code`, chained
 * `cause`) — see the module doc for why it is declared locally.
 */
class WebError extends Error {
    constructor(message, code, options) {
        super(message, options);
        this.name = "WebError";
        this.code = code;
    }
}

/**
 * The Exa-backed search provider. One MCP session is kept per provider
 * instance (lazily established, re-established once on staleness).
 */
class ExaMcpSearchProvider {
    id = EXA_PROVIDER_ID;
    sessionId = null;
    /**
     * @param resolveOptions - snapshot thunk for the NEXT operation, so one
     * search never mixes two config sections (same pattern as web-search-deepseek).
     */
    constructor(resolveOptions) {
        this.resolveOptions = resolveOptions;
    }
    available() {
        const options = this.resolveOptions();
        try {
            return URL.canParse(options.url);
        } catch {
            return false;
        }
    }
    async search(request, signal) {
        const options = this.resolveOptions();
        const scope = abortScope(signal, options.timeoutMs);
        try {
            const text = await this.callSearchTool(options, request, scope.signal);
            const sources = parseExaResults(text);
            // A silent empty list would look like "no matches"; a format change is
            // an error, and the leading bytes are what diagnosis needs.
            if (sources.length === 0) throw providerError(`Exa MCP returned no recognizable search results (leading bytes: ${text.slice(0, 200)})`);
            return { sources, truncated: false };
        } catch (error) {
            if (scope.signal.aborted) {
                if (signal?.aborted === true) throw new WebError("Exa search aborted", "WEB_ABORTED", { cause: error });
                throw providerError(`Exa search timed out after ${String(options.timeoutMs)}ms`);
            }
            if (error instanceof WebError) throw error;
            throw providerError(`Exa search failed: ${errorMessage(error)}`, error);
        } finally {
            scope.done();
        }
    }
    /** Call the configured MCP search tool, re-handshaking once on a stale session. */
    async callSearchTool(options, request, signal) {
        const toolArguments = {
            query: request.query,
            numResults: Math.min(50, Math.max(1, request.maxResults ?? options.numResults)),
        };
        for (let attempt = 0; ; attempt += 1) {
            const sessionId = await this.ensureSession(options, signal);
            const response = await rpc(options, {
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: { name: options.toolName, arguments: toolArguments },
            }, sessionId, signal);
            if ((response.status === 400 || response.status === 404) && attempt === 0) {
                this.sessionId = null;
                continue;
            }
            if (response.status !== 200) throw providerError(`Exa MCP endpoint answered HTTP ${String(response.status)} for tools/call`);
            const body = parseRpcResponse(response.text, 3);
            if (body?.error !== undefined && body?.error !== null) {
                throw providerError(`Exa MCP call failed: ${String(body.error.message ?? JSON.stringify(body.error))}`);
            }
            const result = body?.result;
            const text = resultText(result);
            if (result === undefined || result.isError === true) throw providerError(text || "Exa MCP tool call returned an error");
            return text;
        }
    }
    /**
     * Establish and memoize the MCP streamable-http session for this instance.
     * Two concurrent searches may both handshake before either memoizes (the
     * loser's session simply expires server-side); sharing one in-flight
     * promise would couple their cancellation, which is worse than a spare
     * handshake.
     */
    async ensureSession(options, signal) {
        if (this.sessionId !== null) return this.sessionId;
        const init = await rpc(options, {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: "dsh-web-search-exa", version: "0.1.0" },
            },
        }, null, signal);
        if (init.status !== 200 || init.sessionId === null) {
            throw providerError(`Exa MCP initialize failed (HTTP ${String(init.status)})`);
        }
        const ready = await rpc(options, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId, signal);
        if (ready.status >= 400) throw providerError(`Exa MCP initialized notification failed (HTTP ${String(ready.status)})`);
        this.sessionId = init.sessionId;
        return this.sessionId;
    }
}

/** POST one JSON-RPC message and read the text body plus session header. */
async function rpc(options, body, sessionId, signal) {
    let response;
    try {
        response = await fetch(options.url, {
            method: "POST",
            redirect: "error",
            headers: {
                "content-type": "application/json",
                "accept": "application/json, text/event-stream",
                ...(sessionId !== null ? { "mcp-session-id": sessionId } : {}),
            },
            body: JSON.stringify(body),
            ...(signal !== undefined ? { signal } : {}),
        });
    } catch (error) {
        throw new Error(`request to ${options.url} failed: ${errorMessage(error)}`, { cause: error });
    }
    return { status: response.status, sessionId: response.headers.get("mcp-session-id"), text: await response.text() };
}

/** Parse a JSON-RPC response body that is either raw JSON or an SSE stream. */
function parseRpcResponse(text, id) {
    const candidates = [];
    const trimmed = text.trimStart();
    if (trimmed.startsWith("{")) {
        try { candidates.push(JSON.parse(trimmed)); } catch { /* fall through */ }
    } else {
        for (const line of text.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            try { candidates.push(JSON.parse(line.slice(5).trim())); } catch { /* skip malformed frame */ }
        }
    }
    return candidates.find((value) => value?.id === id) ?? candidates[candidates.length - 1];
}

/** Join the text blocks of an MCP tool result into one string. */
function resultText(result) {
    if (result?.content === undefined || !Array.isArray(result.content)) return "";
    return result.content
        .filter((block) => block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
}

/**
 * Parse Exa's hosted `web_search_exa` text output into seam sources. Blocks
 * follow the stable shape `Title:/URL:/Published:/Author:/Highlights:` and
 * are separated by `---` rules; anything without a http(s) URL is skipped.
 */
function parseExaResults(text) {
    const sources = [];
    const blocks = text.split(/\r?\n[ \t]*-{3,}[ \t]*\r?\n/);
    for (const block of blocks) {
        const url = /^URL:[ \t]*(\S+)/m.exec(block)?.[1];
        if (url === undefined || !/^https?:\/\//i.test(url)) continue;
        const title = /^Title:[ \t]*(.+)$/m.exec(block)?.[1]?.trim();
        const publishedRaw = /^Published:[ \t]*(.*)$/m.exec(block)?.[1]?.trim();
        const snippetRaw = block.split(/^Highlights:[ \t]*$/m, 2)[1]?.trim();
        const date = parseDate(publishedRaw);
        sources.push({
            url,
            ...(title !== undefined && title.length > 0 ? { title } : {}),
            ...(snippetRaw !== undefined && snippetRaw.length > 0 ? { snippet: snippetRaw.slice(0, SNIPPET_MAX_CHARS) } : {}),
            ...(date !== undefined ? { publishedAt: date } : {}),
        });
    }
    return sources;
}

/** ISO timestamp for parseable dates; undefined for `N/A`, blanks, garbage. */
function parseDate(raw) {
    if (raw === undefined || /^(n\/a|unknown|-)?$/i.test(raw.trim())) return undefined;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Race a caller signal against a whole-operation timeout. */
function abortScope(signal, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Exa search timed out after ${String(timeoutMs)}ms`)), timeoutMs);
    const onAbort = () => controller.abort(signal.reason);
    if (signal?.aborted === true) controller.abort(signal.reason);
    else signal?.addEventListener("abort", onAbort, { once: true });
    return {
        signal: controller.signal,
        done: () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        },
    };
}

/** Stable provider-failure error for the web seam. */
function providerError(message, cause) {
    return new WebError(message, "WEB_PROVIDER_ERROR", cause === undefined ? undefined : { cause });
}

/** Error message extraction that never throws. */
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

/** Read one plain config value with its fallback (no schema: values are raw). */
function readField(value, fallback) {
    return value === undefined || value === null || value === "" ? fallback : value;
}

/** Register the Exa provider with `ctx.web`. */
function apply(ctx, config = {}) {
    const provider = new ExaMcpSearchProvider(() => ({
        url: readField(config.url, DEFAULT_URL),
        toolName: readField(config.toolName, DEFAULT_TOOL),
        numResults: readField(config.numResults, DEFAULT_NUM_RESULTS),
        timeoutMs: readField(config.timeoutMs, DEFAULT_TIMEOUT_MS),
    }));
    // The seam registers the provider on ITS own context, so this plugin keeps
    // the returned disposer on its own fiber: unloading or HMR-reloading then
    // cannot leave a stale provider behind (a reload would otherwise fail with
    // WEB_DUPLICATE_PROVIDER). The disposer is idempotent.
    const unregister = ctx.web.registerSearchProvider(provider);
    ctx.effect(() => unregister, "web-search-exa: search provider");
}

export { EXA_PROVIDER_ID, ExaMcpSearchProvider, apply, inject, name };
