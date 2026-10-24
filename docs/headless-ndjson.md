# 无头 NDJSON 事件契约

## 状态

- 2026-10-22 落地。`-p` 打印模式的结构化输出契约，借鉴 ZCode 的 headless 事件流。
- 2026-10-24 对抗复核：补全表中缺失的 5 个事件类型（`sub_tool_start`、`session_title`、
  `goal_changed`、`goal_checking`、`stream_recovery`）与 `permission.rule`；修复在终端里运行时
  权限询问把人类文本写进 stdout、污染事件流的缺陷。

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
| `sub_tool_start` | `parent_id`, `name`, `input_preview`, `round?` | 子代理内部工具调用开始 |
| `tool_end` | `id`, `name`, `ok`, `preview` | `preview` 是截断摘要，非全量结果 |
| `sub_tool` | `parent_id`, `name`, `input_preview`, `ok`, `preview`, `round?` | 子代理内部工具调用 |
| `session_title` | `title` | 首轮生成标题时（打印模式默认关闭标题） |
| `goal_changed` | `goal`（`null` 表示清除）, `note?` | 会话目标开始/暂停/完成；goal 字段同样 snake_case |
| `goal_checking` | — | 目标校验调用进行中 |
| `usage` | `input`, `output` | 每次模型响应的 token 计数 |
| `compacting` / `compacted` | `before`, `after`（后者） | 上下文压缩 |
| `retry` | `attempt`, `max_attempts`, `delay_ms`, `reason`, `status?` | 退避重试 |
| `stream_recovery` | `attempt`, `max_attempts`, `mode`, `discarded_chars`, `delay_ms`, `reason` | 流中断后的重启/续写恢复 |
| `cost_warning` | `message` | 预算警告 |
| `hook` | `event`, `message` | hook 输出 |
| `plan_approved` | — | 计划模式批准 |
| `permission` | `description`, `risk`, `decision`, `rule?` | 每次权限询问及决定；`rule` 仅在可保存规则时出现 |
| `result` | `subtype:"success"\|"error"\|"aborted"`, `text`, `duration_ms`, `tokens`, `cost_usd`, `provider`, `model` | 最后一行，回合结算 |

- `result.text` 是 `agent.chat()` 的最终文本；无头消费者只需等 `result` 行。
- `tool_end.preview` 刻意不是全量结果（可能数 MB）；全量在会话文件与 artifact 落盘里。
- **stdout 只有事件行**：在 TTY 里跑 `--output-format stream-json` 时，权限询问的 diff 预览与
  `allow? [y]es / [n]o` 提示（含 readline 的按键回显）一律走 stderr——`createNdjsonEvents()`
  的 `human()` 与 readline 的输出流都指向 stderr，否则这些文本会夹在 NDJSON 行之间让消费者的
  逐行 `JSON.parse` 失败。管道（非 TTY）运行本来就不会提问，直接拒绝授权。

## 实现与测试

- `src/headless.ts`：`createNdjsonEvents()` — 纯发射器，`write` 可注入（单测不碰 stdout），
  第三个参数 `human` 是可注入的人类文本出口（默认 stderr）；`wrapPermission` 包装打印模式的
  ask 回调以记录决定。
- `src/cli.ts`：`runPrint` 在 stream-json 模式下换用 NDJSON 事件、抑制 stdout 的人类输出
  （结尾空行、中断提示），错误/页脚照旧走 stderr；权限询问的预览与 readline 提示在 stream-json
  模式下也改道 stderr。
- `src/cliArgs.ts`：`--output-format` 解析；无效值由 cli 主入口校验。
- 测试：`tests/headless.test.ts`（init 首行、事件全覆盖映射、permission 包装、result 结算、
  每行可解析且带时间戳、人类文本不进入事件流、默认走 stderr、参数解析默认值）。
