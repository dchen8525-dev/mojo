# 无头 NDJSON 事件契约

## 状态

- 2026-10-22 落地。`-p` 打印模式的结构化输出契约，借鉴 ZCode 的 headless 事件流。

## 开关

- `agent -p "<prompt>" --output-format stream-json`：stdout 每行一个 JSON 对象，仅此而已；
  人类可读诊断（MCP 连接、耗时页脚、错误）仍走 stderr。
- 默认 `text` 保持原有行为不变（增量文本直写 stdout）。cron 调度器不受影响（仍用 text）。
- 未知取值报错退出：`Unknown --output-format "..." — try text or stream-json`。

## 事件契约

字段统一 snake_case；每个事件都带 ISO `ts` 时间戳。典型顺序：

| type | 字段 | 说明 |
| --- | --- | --- |
| `system` | `subtype:"init"`, `session_id`, `cwd`, `model`, `permission_mode`, `plan_mode` | 首行；模型解析后发出 |
| `round_start` | `round` | 一轮模型响应开始 |
| `text_delta` | `delta` | 助手文本增量 |
| `thinking_delta` | `delta` | 推理增量（如模型支持） |
| `tool_start` | `id`, `name`, `input_preview`, `input?` | `input` 仅在可用时出现 |
| `tool_end` | `id`, `name`, `ok`, `preview` | `preview` 是截断摘要，非全量结果 |
| `sub_tool` | `parent_id`, `name`, `input_preview`, `ok`, `preview`, `round?` | 子代理内部工具调用 |
| `usage` | `input`, `output` | 每次模型响应的 token 计数 |
| `compacting` / `compacted` | `before`, `after`（后者） | 上下文压缩 |
| `retry` | `attempt`, `max_attempts`, `delay_ms`, `reason`, `status?` | 退避重试 |
| `cost_warning` | `message` | 预算警告 |
| `hook` | `event`, `message` | hook 输出 |
| `plan_approved` | — | 计划模式批准 |
| `permission` | `description`, `risk`, `decision` | 每次权限询问及决定 |
| `result` | `subtype:"success"\|"error"\|"aborted"`, `text`, `duration_ms`, `tokens`, `cost_usd`, `provider`, `model` | 最后一行，回合结算 |

- `result.text` 是 `agent.chat()` 的最终文本；无头消费者只需等 `result` 行。
- `tool_end.preview` 刻意不是全量结果（可能数 MB）；全量在会话文件与 artifact 落盘里。

## 实现与测试

- `src/headless.ts`：`createNdjsonEvents()` — 纯发射器，`write` 可注入（单测不碰 stdout）；
  `wrapPermission` 包装打印模式的 ask 回调以记录决定。
- `src/cli.ts`：`runPrint` 在 stream-json 模式下换用 NDJSON 事件、抑制 stdout 的人类输出
  （结尾空行、中断提示），错误/页脚照旧走 stderr。
- `src/cliArgs.ts`：`--output-format` 解析；无效值由 cli 主入口校验。
- 测试：`tests/headless.test.ts`（init 首行、事件全覆盖映射、permission 包装、result 结算、
  每行可解析且带时间戳、参数解析默认值）。
