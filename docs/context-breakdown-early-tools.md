# /context 用量分解与只读工具流式提前执行（批次 31）

状态：已实现（2026-10-23）｜来源：ZCode 对标 survey 第 3 轮 #9 + #6（S/M 合集）

## 背景与范围

| # | 候选项 | 结果 |
|---|--------|------|
| 9 | `/context` 上下文用量分解（系统提示 / 工具 / 历史 / 预留 / 阈值） | **本批次增强**：命令已有总量展示，补充逐项分解 |
| 6 | 只读工具在模型流结束前尽早执行（降低回合延迟） | **本批次新增**：`StreamEvents.onToolReady` + agent 提前调度 |

## #9 `/context` 用量分解

**问题**：原 `/context` 只报一个总数和消息条数，用户无法判断“是工具 schema 太大、系统提示太大，还是历史太长”，也不知道距离压缩阈值还有多少。

**口径（关键）**：Anthropic/OpenAI 返回的 `input_tokens` 是**整个请求**的输入，已包含系统提示与工具 schema；而 `TokenCounter` 在无锚点时只能估算纯消息历史。因此：

- `TokenCounter` 新增 `anchored` 只读属性（`anchorCount > 0`）。
- 有锚点：`history = input − 估算的 system − 估算的 tools`；`input` 取
  `max(tokenEstimate(), system + tools 估算)`。正常情况下 provider 计数更大、即精确值；若上次
  请求之后工具集或系统提示变大（例如新接入一个大 schema 的 MCP 服务器、记忆文件变长），旧计数
  已覆盖不了下一次请求，此时 input 退化为当前提示的估算下界（残差为 0），而不是把 history
  截为 0 后让三行之和超过 input。
- 无锚点（新会话、刚压缩/恢复）：`input = history 估算 + system + tools`，全部为 CJK 感知估算。
- 分解行（system / tools / history）相加恒等于 `input`；`projected = input + outputReserve`，与自动压缩决策使用同一个预留值（`min(maxOutput, 16384)`，可用 `AGENT_OUTPUT_RESERVE` 覆盖）。

**输出内容**：

```
context window 200,000 tokens
  system prompt      2,910   1.5%  stable 2,600 + volatile 310
  tool schemas       6,120   3.1%  17 tool(s)
  messages           9,370   4.7%  42 message(s)
    ≈ user 1,200 · assistant 2,100 · thinking 0 · tool calls 900 · tool results 4,900 · images 0
  input total       18,400   9.2%  provider count + tail estimate
  output reserve    16,384   8.2%
  projected         34,784  17.4%  input + reserve
  free             165,216  82.6%
compact at 150,000 (75%) · microcompact prune at 140,000 (70%)
```

- 消息分类由新的 `estimateHistoryBreakdown()` 估算（user/assistant/thinking/tool_use/tool_result/images/other），与 `estimateMessagesTokens()` 同口径（两者 total 相等），便于核对。
- 计划模式在标题行标注 `plan mode (read-only tool set)`；工具集合由 `Agent.activeTools()` 统一提供，`chat()` 与 `/context` 共用，避免“显示的工具”和“实际发送的工具”漂移。
- `projected > compactAt` 时输出告警：下一次请求会先触发自动压缩。
- 刻意不做：不展示逐条消息明细（历史可能很长）；不做每次请求的持久化采样（`/cost` 已覆盖费用侧）。

## #6 只读工具流式提前执行

**问题**：模型响应里工具调用通常先于文本尾部到达；此前必须等整个流结束、拿到完整 `AssistantTurn` 后才开始执行，白白多等一段网络/生成时间。

**API 扩展**：`StreamEvents.onToolReady(tool: ToolUseBlock)` —— 参数已完整、但外层响应尚未结束的工具调用。两个后端分别实现：

- **Anthropic**（真正提前）：`content_block_start(tool_use)` 建立累计器，`input_json_delta` 拼接参数，`content_block_stop` 时解析 JSON 并发出。此时模型通常还在生成后续文本/其它工具块。
- **OpenAI**：协议没有 block 结束标记，并行调用按 index 依次流式；当**新的 index 出现**时，把此前所有调用定稿并发出。因此多调用场景下前 N−1 个能提前执行，最后一个要等流结束（单调用无收益，但也不会变慢）。
- 共享工具 `src/llm/toolStream.ts`：`parseToolInput`（空参数 → `{}`，非法/未完成 JSON → `undefined` 不执行，非对象 → `{}` 交给工具报参数校验错误）、`ToolBlockAccumulator`、`readyToolCall`。

**Agent 调度**（`chat()` 每轮）：

- 过滤器：仅 `getTool(name)?.isReadOnly && parallelSafe && earlySafe !== false && tool.id` 的调用提前
  执行；写文件、bash、todo 等一律等正常批次。`isReadOnly` 是**权限**语义，不等于可重放：流
  重启会丢弃本次响应并重跑提前调用，所以 `task`（派生子代理）、`send_message` /
  `message_parent`（投递消息）这三个“只读但有外部副作用”的工具显式 `earlySafe: false`，
  否则一次断开就会启动两个 detached 子代理、投递两遍消息。
- 提前执行的 `runTool()` 立即发出既有的 `onToolStart`/`onToolEnd` 事件（CLI/GUI 调用卡片会先出现），结果以 `tool_use_id` 存入 Map。
- 流结束后：按 `turn.toolUses` 顺序取提前结果，其余工具仍走 `planWaves`/`runWave`（并行安全相邻合波、变更工具独占）；最终 tool_result 顺序与调用顺序一致。
- 双保险：同一 id 只提前执行一次；`onToolReady` 里再跑一次 `runTool` 的 Promise 包裹 catch，避免未处理拒绝。
- 取消：每轮派生的 `earlyAbort` 转发外层 `signal`；流失败时主动 abort 提前工具。用户中断时提前工具随外层信号一起取消。
- 失败/浪费语义：提前工具只读，所以流中断、`length` 截断导致工具批次被丢弃时，最坏情况只是多做一次只读调用。该假设只对无副作用的工具成立，因此有外部副作用的工具用 `earlySafe: false` 排除（见上）。OpenAI 无 id 的调用不提前（后端稍后会补 id，无法匹配）。
- 交互契约变化：`tool_start`（以及 `sub_tool_start`）现在可能早于 `usage` 到达；`tool_use_start` 语义不变（参数仍流式）。SSE 回放夹具 `golden-turn.jsonl` 已按新顺序更新。
- 刻意不做：不做参数 JSON 的“解析成功即执行”（半截 JSON 可能恰好合法）；不做提前执行结果跨流重试复用（只读重复可接受）；不改 tool_search 暴露时机（仍从下一轮生效）。

## 测试

- `tests/toolStream.test.ts`（新）：参数解析边界、按 block 关闭才发出、非法 JSON 跳过、重复 stop 幂等、无 id/无 name 拒绝。
- `tests/llmToolReady.test.ts`（新）：Anthropic 脚本流验证 `onToolReady` 早于后续文本增量；OpenAI 脚本流验证新 index 出现时只提前发出前一个调用。
- `tests/agent.test.ts`：并行只读工具在 `send()` 返回前完成且不重复执行；变更/非并行安全工具不提前；提前与普通工具混合时结果顺序不变；`earlySafe: false` 的 `task` 在流重启后只派发一次；`contextBreakdown` 在有无锚点两种状态下的加和关系（含“上一次请求后工具集变大、旧锚点不再覆盖当前提示”的情形）。
- `tests/tokens.test.ts`：`estimateToolTokens`；`estimateHistoryBreakdown` 与 `estimateMessagesTokens` 同口径、图片（含嵌套在 tool_result 中的图片）分类。
- `tests/agentCommands.test.ts`：`/context` 输出包含分解行与两个阈值、越界告警、计划模式标注。
- `tests/guiSseReplay.test.ts`：重新捕获 `golden-turn.jsonl`（`tool_start` 提前到 `usage` 前）。

## 配置速查

| API / 行为 | 说明 |
| --- | --- |
| `StreamEvents.onToolReady(tool)` | 新事件：参数完整、响应未结束的工具调用 |
| `Agent.contextBreakdown()` | 返回 `ContextBreakdown`（window/input/history/system*/tools/toolCount/outputReserve/projected/compact*/microcompact*） |
| `/context` | 展示分解与阈值；计划模式标注只读工具集 |
| `AGENT_OUTPUT_RESERVE` | 既有变量，同时影响分解中的 output reserve 与自动压缩 |
