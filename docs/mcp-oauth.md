# MCP OAuth 2.1 授权

## 状态

- 2026-10-22 落地。本文是远程 MCP 服务器 OAuth 授权的规范。

## 开关与配置

- 远程服务器（`url`）加 `"oauth": true` 启用浏览器授权；stdio 服务器配置该项会被拒绝
  （`oauth is only valid for remote servers`）。
- `oauth` 与静态 `headers` 可并存：授权成功后 SDK 在 `Authorization: Bearer <token>` 之外
  仍会带上配置的 headers（用于网关等额外凭据）。
- 未配置 `oauth` 时保持原有行为，不发起任何授权请求。

## 流程

1. 传输连接收到 401，解析 `WWW-Authenticate` 的 `resource_metadata`。
2. RFC 9728 受保护资源元数据 → 授权的服务器地址；RFC 8414 / OIDC 元数据发现端点。
3. 动态客户端注册（DCR，公开客户端 `token_endpoint_auth_method: "none"`）。
4. PKCE（S256）生成授权 URL，`state` 随机；通过系统浏览器打开，同时把 URL 打到 stderr。
5. 本机回环 `http://127.0.0.1:<随机端口>/callback` 接收授权码，校验 `state` 后交给
   `transport.finishAuth(code)` 换取令牌。
6. 用**新的** transport 重试同一种传输；成功后正常注册工具。

- 自动传输模式（未指定 `type`）下，若 HTTP 返回 401 则先完成授权再重试 HTTP；只有非 401
  失败才会继续尝试 SSE。

## 凭据存储

- 位置：`~/.node-agent/mcp-auth/<服务器名>.json`（名称中的非 `[\w.-]` 字符替换为 `_`）。
  目录 0700、文件 0600。
- 内容：`tokens`（含 refresh_token 与 issuer 绑定）、`clientInformation`、`codeVerifier`、
  `discoveryState`（跳过重复发现）。
- 后续连接直接复用令牌；过期时用 refresh_token 刷新，无需再次打开浏览器。授权服务器变化
  时 SDK 依据 issuer 丢弃旧凭据并重新注册/授权。

## 超时、取消与错误

- 等待回调默认 120 秒，可用 `AGENT_MCP_OAUTH_TIMEOUT_MS` 或 `McpManagerOptions.oauthTimeoutMs`
  覆盖。超时错误包含最近一次授权 URL，便于手动完成。
- 打开浏览器失败（如无头 Linux 缺少 `xdg-open`）只记录“请手动打开”的日志并继续等待回调，
  授权 URL 同时保留在日志与超时错误中。
- 回调 `state` 不匹配返回 400 且不结束等待；`error=...` 回调转为连接错误。
- 回调可能早于等待方到达（浏览器跳转很快），授权码/错误会被缓存，不会丢失。
- 连接结束时回环服务器必然关闭；授权失败不重试其他传输（未授权前没有意义）。
- 目前只支持动态注册的服务器；预注册 client 不在范围内。

## GUI

- 远程服务器表单新增「OAuth 登录」复选框；列表显示 OAuth 标记。保存后立即重连，首次连接
  会拉起浏览器；令牌不展示、不写入配置文件。

## 代码与测试

- `src/mcpAuth.ts`：凭据存储、回环回调、`OAuthClientProvider`。
- `src/mcp.ts`：`connectRemote` 的 401 → 授权 → 重试编排；`McpManagerOptions`。
- `src/openBrowser.ts`：跨平台打开浏览器（CLI 与 OAuth 共用）。
- 测试：`tests/mcpAuth.test.ts`（存储/回调/竞态/超时）、`tests/mcpRemoteOAuth.test.ts`
  （本地假 OAuth + MCP 服务器端到端，含令牌复用）。
