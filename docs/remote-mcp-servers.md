# 远程 MCP 服务器（Streamable HTTP / SSE）

## 状态

- 2026-10-22 落地。本文是远程 MCP 服务器的配置、传输选择与失败语义的规范。

## 配置

- 服务器条目二选一：本地用 `command`（+ `args` / `env`），远程用 `url`。同时配置两者会以失败状态报告
  `config has both command and url — keep only one`。
- `url` 必须是 `http://` 或 `https://` 的合法地址。
- 可选 `type: "http" | "sse"` 固定传输；缺省时先尝试 Streamable HTTP，连接失败再回退到旧版 SSE。
- `headers` 是 `KEY=VALUE` 映射，随每个远程请求发送（如 `Authorization`），与 `env` 一样以 0600
  权限写入 `~/.node-agent/mcp.json` 或 `<cwd>/.mcp.json`。
- 项目 `.mcp.json` 的同名服务器覆盖全局；`disabled: true` 保持配置但不连接。
- `oauth: true` 对远程服务器启用 OAuth 2.1 授权，详见 [mcp-oauth.md](mcp-oauth.md)。

## 连接与暴露

- 每次传输尝试有 15 秒连接超时；显式 `type` 时不做回退，配置错误快速失败。
- 连接成功后工具按 `mcp__<服务器名>__<工具名>` 注册，仍走统一的权限确认；工具数超过
  `MCP_DEFER_TOOLS`（12）时进入 tool_search 延迟目录（见 tool-search-deferred-catalog.md）。
- `/mcp` 与 GUI 状态显示实际使用的传输类型（stdio / http / sse）；两种传输都失败时，错误信息
  会列出每个传输的失败原因。

## GUI

- 管理面板新增远程 URL、远程方式（自动 / Streamable HTTP / SSE）与 Headers。URL 非空时忽略
  命令、参数与 env；保存后立即重连并刷新状态。

## 代码

- `src/mcp.ts`：`normalizeMcpConfig`（校验/归一化）、`connectRemote`（传输选择与回退）、
  `McpManager.connect`（注册与状态）。
- `src/gui/server.ts`：`/api/mcp` 快照包含 `url` / `headers` / `type` / `kind`。
- `src/gui/static/{index.html,app.js}`：管理表单与列表展示。
- 测试：`tests/mcpConfig.test.ts`、`tests/mcpRemote.test.ts`（本地 Streamable HTTP 端到端）、
  `tests/guiServer.test.ts`、`tests/guiDom.test.ts`。
