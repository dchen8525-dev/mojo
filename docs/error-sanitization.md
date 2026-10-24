# 批次 40：错误信息脱敏（error-sanitizer）

状态：已实现（2026-10-24）｜survey 第 7 轮缓办项

## 模块（src/errorSanitizer.ts）

移植 ZCode `telemetry/error-sanitizer.ts` 的 `sanitizeErrorMessage`：provider/传输层错误可能回显请求 URL、认证头、本机路径甚至整段响应正文，这些文本在离开进程边界（落盘或跨界面显示）前统一脱敏：

- **URL 收敛**：`https?://…` 解析后只保留 `scheme://host/路由`，整段查询串丢弃（比逐参数 `{redacted}` 更彻底，userinfo 凭证随之消失）；路由段含 `@`/长数字/长 hex/UUID 时替换为 `{segment}`，解析失败整体替换 `{url}`。
- **凭证形态**：`authorization: Bearer/Basic …` 头（含引号、等号变体）、查询串与 KV 形态的 `api_key/token/secret/password/cookie/…`、裸 `Bearer/Basic` 令牌、通用 `sk-/rk-/pk-` 与 `sk_live_/sk_test_`、GitHub `ghp_…`/`github_pat_…`、GitLab `glpat-…`、Slack `xox[abposr]-…`、npm `npm_…`、AWS `AKIA…`、Google `AIza…`、JWT（`eyJ…`）、PEM 私钥整段、`名字@16位hex`（SDK 风格凭证）→ `{redacted}` / `{secret}`。
- **本机信息**：Unix/Mac 家目录与临时目录路径、Windows 盘符路径 → `{path}`；邮箱 → `{email}`；控制字符折叠为空格；空白归一。
- **截断**：先按 4096 字符预截（有界正则成本），清洗后再截到 2048 字符。

## 接线边界（只动传输/落盘，不动分类与调试载荷）

| 边界 | 处理 |
|---|---|
| journal 落盘（journal.ts `recordJournalTurn`） | `error` 字段落盘前脱敏；**request messages 保持原文**——journal 本就是调试载荷（与 tool stderr 同理），脱敏会破坏排障价值 |
| GUI `turn_error` 广播（gui/server.ts 两处） | 显示前脱敏；`aborted` 判定仍用原始消息 |
| TUI 错误行（ui/app.tsx runTurn catch） | `setError` 前脱敏 |
| print 模式 stderr（cli.ts runPrint catch） | 输出前脱敏 |

刻意**不脱敏**：工具结果中的 stderr/错误输出（进入会话历史的 `tool_result`）——路径等是模型排障的合法上下文，ZCode 同样只清洗遥测错误不清洗工具输出。错误分类（如 `isContextOverflowError`）在源头用原始消息判断，不受影响。

## 测试

- `tests/errorSanitizer.test.ts`（9）：Bearer/认证头（含变体）、GitHub/GitLab/Slack/npm/AWS/Google/JWT/PEM 等令牌族、查询串（URL 内整段丢弃 vs URL 外 KV 就地 `{redacted}`）、URL 路由段/userinfo、Unix+Windows 路径、邮箱/控制字符、长文截断且密钥不可见、普通错误原样透传。
- `tests/journal.test.ts`（+1）：带 `api_key` + Bearer 的错误落盘后确认密钥不可见、URL 收敛生效。

## 验证

`npx vitest run`：89 文件 / 1229+ 通过 / 7 跳过；`npm run lint`、`npm run build` 全绿。
