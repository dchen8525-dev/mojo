# 对抗分析 10 轮（2026-10-22）

## 状态

- 2026-10-22 完成。本文记录对 mojo 的 10 轮对抗性审查：每轮选一个攻击面，复现问题、
  修复并补回归测试；只列真实缺陷与最终防线，不列假设性风险。

## 范围与结论

| 轮次 | 攻击面 | 主要缺陷（已修复） |
| --- | --- | --- |
| 1 | cron 调度与运行认领 | 进程被杀后 `running` 状态无人回收；跨进程重复执行；运行日志路径可控 |
| 2 | cron 表达式解析 | DST 回拨时返回过去时间；手工改写的任务 id 可逃出 runs 目录 |
| 3 | MCP 配置与启动 | 项目 `.mcp.json` 未经信任即可拉起任意命令；清洗后重名的服务器互相顶掉工具 |
| 4 | GUI HTTP/SSE | 并发 POST 双开 turn；未知权限决定被持久化成允许；敏感响应可缓存；路径型 id 写入 |
| 5 | 会话与持久化 | 元数据 id 可指向他人文件；符号链接/超大文件被当会话读取；畸形消息进入历史；超长正则 |
| 6 | 文件工具与路径 | 可读 `~/.ssh` 等凭据库（含符号链接绕过）；只读 bash 可带外部绝对路径；超大文件/模式 |
| 7 | 记忆注入与召回 | 记忆文件无界读取/追加；可写穿符号链接；wrapper 标签注入可闭合；长查询全量扫描 |
| 8 | 子代理与后台任务 | `task` 的只读标记使子代理写入绕过权限；跨会话报告泄漏；子代理无 read-before-edit；标签/提醒注入 |
| 9 | LLM 流与工具调用 | 切换 OpenAI 丢图片；网关分片/重发工具调用解析错乱；截断调用被执行；重复 tool id |
| 10 | web 抓取与 OAuth 回调 | IPv4 兼容/转换型 IPv6 绕过 SSRF；已中止的 turn 仍发请求；OAuth 回调未校验 Host、state 可重放、授权 URL 未限 scheme |

## 关键修复

### 1–2：cron

- `runStartedAt` + 过期阈值同时用于调度与手动运行：另一个进程留下的 `running` 在超过
  `STALE_RUN_MS` 后回收为 `error`，新鲜认领保持不动。
- 运行认领写盘后再执行，避免两个调度器同时触发同一任务。
- `nextRun` 以绝对时间推进，并在 DST 回拨导致结果早于扫描起点时改用较晚偏移重算。
- 运行日志文件名对任务 id 做 `[A-Za-z0-9_-]` 白名单清洗并截断。

### 3：MCP

- 项目级 `.mcp.json` 需 `/mcp trust` 批准当前文件内容的 SHA-256；内容变化即失效，未信任时
  只加载全局配置。GUI「管理 → MCP」可批准并显示未信任文件。
- 工具前缀按清洗后的服务器名去重，重名服务器直接报配置错误而不是静默覆盖工具。

### 4：GUI

- 单轮占位在任何 `await`（`@` 文件展开、斜杠命令）之前完成，第二个并发 POST 得到 busy。
- 权限决定只接受白名单值；未知决定返回错误，不落盘成 allow 规则。
- API 响应 `cache-control: no-store`，静态资源 `no-cache` + `x-frame-options: DENY`。
- 所有按 id 写入/删除的会话端点先校验 `ID_RE`，路径型 id 不会逃出 sessions 目录。

### 5：会话

- 文件名即会话 id；文件内 meta 的 `id` 不再覆盖它。
- 只接受 `lstat().isFile()` 的普通文件，符号链接与目录被跳过；元数据行有长度上限。
- 反序列化时校验 `role`/`content` 形状，畸形消息不进入历史、搜索或 resume。
- 搜索正则限制 200 字符，避免回溯爆炸。

### 6：文件工具

- `isSensitivePath` 拒绝 `.ssh`、`.gnupg`、`.aws`、`.kube`、`.node-agent` 等凭据目录与
  `id_rsa`、`.netrc`、`.git-credentials` 等文件。
- 读、glob、grep 在词法检查后再做 `realpath` 复查，符号链接不能把路径带进凭据库。
- 只读 bash 若参数含绝对路径、`~`、`..`、`%VAR%` 等外部路径标记，则不再自动放行。
- `read_file` 单文件上限 16 MiB；glob 模式必须相对；grep 目标与符号链接逐文件复查。

### 7：记忆

- 读取/追加前 `lstat`，只接受普通文件；`readIfExists` 大文件只读尾部 512 KiB，写入走原子替换。
- 注入前把 `<user_memory|project_memory|memory_entry` 的 `<` 转义，记忆内容不能闭合
  wrapper 标签；preamble 明确记忆是数据而非指令。
- 召回查询截断到 4,000 字符、最多 256 个词项；文件超过 512 KiB 时保留尾部 256 KiB 并按
  `## ` 边界裁剪。

### 8：子代理

- `Agent.executeToolResult` 构造 `askPermission` 时固定传 `readOnly=false`：`task` 工具虽然
  自身只读，但其 worker 子代理会写入，之前因此完全绕过权限询问（最高危的一项）。
- 子代理报告与后台任务结果按 `sessionId` 隔离，前端只能看到本会话的任务。
- 子代理持有独立 `FileStateStore`，写入前必须先读过目标文件。
- 任务标签单行化并截断到 60 字符；`</system-reminder>` 在注入前转义。

### 9：LLM

- OpenAI 消息转换保留 `image` 块（data URL / 远程 URL），切换 provider 不再丢图。
- 工具调用增量按 index → id → 末项匹配，容忍网关重发 id/name；截断（`length`）的整批调用
  不执行；缺失或重复的 tool id 补全为唯一值。
- 流中断恢复沿用「仅纯文本中断可续写」的规则。

### 10：web 与 OAuth

- `isBlockedAddress` 用统一 IPv6 展开处理映射（`::ffff:a.b.c.d`）、兼容（`::a.b.c.d`）与
  转换（`::ffff:0:a.b.c.d`）形式；`::7f00:1`、`::ffff:0:7f00:1` 等不再能访问回环。
- 数字型/压缩型 IPv4（`2130706433`、`0x7f.1`、`127.1`）由 WHATWG URL 规范化后仍被拦截。
- 已中止的 `AbortSignal` 在开 socket 前直接失败，不再等 20 秒超时。
- OAuth 回调校验 Host 必须等于 `127.0.0.1:<port>`（DNS rebinding 防护），state 单次使用，
  授权 URL 只允许 `http(s)`，回调页带 `no-store` / `no-referrer` / `default-src 'none'`。

## 验证

- `npx vitest run`：63 个文件，803 passed / 5 skipped。
- `npx tsc --noEmit`、`npm run build` 均通过。
- 新增回归：`tests/pathGuards.test.ts`、`tests/llmOpenAi.test.ts`，以及 web、mcpAuth、memory、
  agent、taskBackground、reminder、session、cron、guiServer 等测试文件的增量用例。
