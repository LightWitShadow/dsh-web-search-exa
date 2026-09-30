# web-search-exa — 内置 web_search 改用 Exa（无 key）

把 DSH 内置 **`web_search` 工具**的搜索后端换成 **Exa**，走官方托管 MCP 的**匿名通道**，不需要 API key。

## 背景：DSH 的 web search 是 provider 注册制

`web_search` 工具本身由 `@deepseek-ai/dsh-tool-web` 提供，它只调用 `ctx.web` 这个 seam：

```
web_search 工具 → ctx.web.search() → 选中的 search provider → 具体后端
```

provider 通过 `ctx.web.registerSearchProvider({ id, available(), search() })` 注册；选哪个由 `web` 插件的配置 `searchProvider`（或环境变量 `DSH_WEB_SEARCH_PROVIDER`）决定。DSH 自带的 provider 是 `deepseek-official`（需要 `DEEPSEEK_API_KEY`，或使用 DeepSeek 账号登录）。本插件注册 **provider id = `exa`**，并**在同一个 bundle patch 里把 `web` 行指到它**。

## 为什么可以无 key

Exa 的 REST API 需要 key，但**官方托管 MCP 端点支持匿名访问（有速率限制）**——官方 README 原文：*"The hosted MCP server works anonymously with rate limits."* 实测 `initialize` 返回 200 且能正常搜索。

```
web_search → ctx.web → ExaSearchProvider(id=exa)
   → MCP streamable-http: initialize → notifications/initialized → tools/call web_search_exa
   → https://mcp.exa.ai/mcp   （匿名）
```

## 配置

配置分两处，都在 bundle 的 `cordis.patch.yml` 里（`web` 行的 id 是 `web`，`searchProvider`/`fetchProvider` 是它**仅有的两个** config 键）：

```yaml
# 1) 插入 provider 行并带上默认配置
- insert:
    - id: web-search-exa
      name: '@local/dsh-web-search-exa'
      config:
        url: https://mcp.exa.ai/mcp   # Exa 官方托管 MCP
        toolName: web_search_exa      # 该端点上的搜索工具名
        numResults: 10                # 默认结果数（1–50）
        timeoutMs: 45000              # 单次搜索整体超时

# 2) 把选择指过来。必须：注册了 provider 但没人选，web_search 永远不会调用它。
#    patch 会整行替换 config，所以 fetchProvider 必须重述（值取自 dsh-base）。
- id: web
  config:
    searchProvider: exa
    fetchProvider: http
```

想改这两行，不必动本包：在自己的 profile `cordis.patch.yml` 里用同 id 覆盖即可（profile 层在 bundle 层之后应用，后写胜出）。

> **别把 `web` 的选择漏掉**：当 `searchProvider` 为空而 `deepseek-official` 与 `exa` 同时可用时，seam 会以 `multiple usable web providers are registered …` 失败——所以"只插 provider 行"是坏配置，不是"没生效"。

### 日后提额（可选）

匿名通道有速率限制。想提额时改 `url` 即可，**key 始终由你自己填，不经过对话**：

| 方式 | url |
|---|---|
| OAuth 登录 | `https://mcp.exa.ai/mcp?login` |
| API key | `https://mcp.exa.ai/mcp?exaApiKey=<你的key>` |
| 启用更多工具 | `https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa` |

## 与 web_fetch 的关系

本插件**只替换搜索**。`web_fetch` 工具走的是另一个 provider（`dsh-web-fetch-http`，id = `http`，纯 HTTP 抓取），不受影响，也无需改动——所以 `web` 行的覆盖里要保留 `fetchProvider: http`。

## 结构

| 文件 | 角色 |
|---|---|
| `index.js` | Host 半边：一个零依赖的 Exa provider（手写 MCP streamable-http 客户端） |
| `cordis.patch.yml` | 插入 provider 行、带上默认配置，并把 `web` 行指到 `exa` |
| `locale/en.json`、`locale/zh.json` | **DSH 插件描述**：插件管理界面显示的标题与简介 |
| `package.json` | `dsh.bundle.patch` + `exports`（放行 `./package.json` 与 `./locale/*.json`，否则描述读不到） |

**零依赖是刻意的**：插件以 pnpm `link:` 方式安装，其真实路径下解析不到任何 `@deepseek-ai/*`，因此只用 `node:` 内置能力；它需要的一切宿主能力都来自活的服务对象（`ctx.web`）。

**插件描述**由 DSH 通过 ESM 解析器读取导出资源得到：`<包名>/locale/en.json`（精确的英文资源）以及同目录下每个 `<lang>.json`，内容形如 `{"meta":{"title":"…","description":"…"}}`；缺省时回落到 `package.json` 的 `name`/`description`。详见 `dsh-session-delete/README.md` 的「DSH 插件描述」一节。

## 实现要点

- **MCP 握手**：`initialize`（带 `protocolVersion: 2025-06-18`）→ 从响应头取 `mcp-session-id` → `notifications/initialized` → `tools/call`。
- **会话复用与自愈**：`mcp-session-id` 缓存在 provider 实例上；`tools/call` 收到 400/404 视为会话过期，清空会话并**重建一次**（仅一次，避免死循环）。
- **响应解析**：兼容原始 JSON 与 SSE（逐行 `data:` 帧），按 `id` 匹配响应。
- **超时与取消**：单次搜索整体超时（默认 45s），与调用方 `AbortSignal` 竞速；取消映射为 `WEB_ABORTED`，其余失败映射为 `WEB_PROVIDER_ERROR`（沿用 DSH 的错误码约定）。
- **结果映射**：把 Exa 的文本输出（`Title:/URL:/Published:/Author:/Highlights:` 块，`---` 分隔）解析为 seam 的 `sources[]`（`url/title/snippet/publishedAt`），snippet 单条上限 2000 字符；无解析结果时抛错而不是返回空列表。
- **选择语义**：`available()` 只校验 `url` 可解析——匿名端点无需凭据，因此恒为可用。

## 验证

```powershell
# 直接跑 provider（不需要 DSH 运行）；node 用安装目录自带的那个
& "D:\Applications\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" -e "
import('file:///C:/Users/<你>/.dsh/plugins/dsh-web-search-exa/index.js').then(async (m) => {
  const p = new m.ExaMcpSearchProvider(() => ({ url: 'https://mcp.exa.ai/mcp', toolName: 'web_search_exa', numResults: 3, timeoutMs: 45000 }));
  const r = await p.search({ query: 'DeepSeek Harness', maxResults: 3 });
  console.log(r.sources.length, r.sources[0]?.url);
});"
```

在会话里则直接调用 `web_search` 工具：返回的来源应来自 Exa 索引。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `configured web provider "deepseek-official" is not registered` | `web` 行没指到 exa（或 `web-search-deepseek` 已禁用但选择没改）→ 检查 `searchProvider: exa` |
| `multiple usable web providers are registered …` | 同时注册了多个可用 provider 且没有显式选择 → 显式设置 `searchProvider` |
| `Exa MCP endpoint answered HTTP 4xx/5xx` | 匿名速率限制或端点变更；提额见上文，或稍后重试 |
| `Exa search timed out after …` | 网络慢/代理问题；调大 `timeoutMs` |
| 搜索能跑但结果为空 | Exa 文本格式可能变化 → 看宿主日志里的 `no recognizable search results`，并按新格式调整 `parseExaResults` |
| 插件管理界面里显示的是裸包名而不是标题 | `exports` 里少了 `./package.json` 或 `./locale/*.json`，或 `locale/en.json` 不存在/不是合法 JSON |

## 开发

- 两处副本需同步：`~/.dsh/plugins/dsh-web-search-exa/`（**运行源**）与工作区开发副本。
- **Host 半边改动需重启 DSH 生效**（ESM 模块缓存）；改完可用上面的 standalone 测试先验证，再重启。
- 与自带 provider 的对比参考：`@deepseek-ai/dsh-web-search-deepseek`（同样的 seam、同样的 `apply/inject/name` 导出形态，其 provider id 是 `deepseek-official`）。
