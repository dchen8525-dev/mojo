# 流恢复状态机（批次 33）

状态：已实现（2026-10-23）｜来源：ZCode 对标 survey 第 3 轮 #11

## 背景与范围

模型流在输出中途断开时，此前只有两条路：`withRetry` 整轮重试（已生成文本全部丢弃并重新计费），或用户手动取消后打捞部分文本。ZCode 的做法是把“断点”分成可续写与不可续写两类，分别恢复。本批次在 `LLM.sendResumable` 内实现同一语义，改动自包含，不改变上层 `Agent.chat` 的回合结构。

| 断点 | 模式 | 处理 |
| --- | --- | --- |
| 文本生成中，尚未出现工具调用 | `resume` | 保留已产出文本，作为续写锚点重新请求，只向前端补发新后缀 |
| 已有工具调用开始流式生成（参数可能不完整） | `restart` | 丢弃本次响应，从未改动的 messages 重发；前端按 `discardedChars` 回滚 |

## 状态机

`sendResumable` 维护三个量：

- `partial`：跨多次 resume 累计的正文，也是下一次请求的锚点；restart 时清空。
- `visible`：宿主（CLI/TUI/GUI/NDJSON）已经渲染的字符数；中断打捞与 restart 回滚都以它为准。
- `recoveries`：本次逻辑请求已用的恢复次数（resume 与 restart 共享预算）。

每次尝试：

1. **构造续写请求**。`partial` 为空时原样发送；否则：
   - Anthropic：在 messages 末尾追加 `assistant` 文本 prefill（去掉尾部空白，prefill 不能以空白结尾，全空白则放弃续写直接报错）。
   - OpenAI：追加一条 `user` 消息，声明“上一条回复在流中途被截断，不要重复，从这一点继续”，并附上 `partial`。
2. **收集增量**。续写尝试的 `onTextDelta` 先只累加不转发（OpenAI 无 prefill 会重复已输出内容）；成功后用 `mergeText(partial, turn.text)` 去掉最长 200 字符的尾部重叠，再把 `text.slice(visible.length)` 一次性补发给前端。首次尝试则实时透传并累加 `visible`。
3. **中断分类**。两个后端把流中断统一包装为 `StreamInterrupted(partialText, cause, { toolStarted })`：
   - `toolStarted=false` → `resume`：`combined = mergeText(partial, err.partialText)`。
   - `toolStarted=true` → `restart`：工具参数可能只到一半，不可恢复，丢弃本次响应。
4. **可恢复性**。仅瞬时原因恢复：408/429/5xx、连接类错误（含 undici 的 `terminated`/`premature close`/socket 码）、`StreamIdleError`；400/401/403 等直接终止，不浪费预算。无 `cause` 视为瞬时（测试与直接断 socket 的网关）。
5. **预算与退避**。`recoveries < maxRecoveries` 才继续；退避复用重试参数：`min(baseMs * 2^n, maxDelayMs)` 加 ±jitter，等待期间可被用户取消。
6. **终止**。预算耗尽或不可恢复时抛 `StreamRecoveryExhausted(partialText, attempts, cause)`。`partialText` 是 `visible`（restart）或 `combined`（resume），与用户屏幕上看到的内容一致。
7. **续写中被取消**。用户取消发生在续写尝试中时，先 `mergeText(partial, 本次累计增量)` 再抛 `CancelledStreamError`：OpenAI 无 prefill 会从头发送，直接拼接会把重叠段落重复打捞进历史；Anthropic 的 prefill 续写则退化为追加。打捞文本因此与屏幕内容一致且不重复。

### 事件与前端同步

恢复前发出 `onStreamRecovery(info)`：

```ts
interface StreamRecoveryInfo {
  attempt: number;          // 第几次恢复（1-based）
  maxAttempts: number;      // 本次请求的恢复预算
  mode: "resume" | "restart";
  discardedChars: number;   // restart 时前端应删除的字符数；resume 恒为 0
  delayMs: number;          // 本次退避时长
  reason: RetryReason | "stream"; // rate-limit | timeout | server | connection | stream
}
```

四端接线：

- **CLI**：打印 `… stream interrupted — resuming from the cut-off point in 1.2s (1/4)` 或 `discarding 87 chars and restarting …`。
- **Ink TUI**：restart 时清空当前流文本，删除本 round（`roundRef`）的工具行与旁白，插入系统提示；resume 不动已显示文本。
- **GUI server**：restart 时按 `discardedChars` 裁剪 `turn.text`，丢弃当前 round 的工具条目，裁剪当前 round 段的正文/thinking，再广播 `stream_recovery`。
- **GUI 前端**：收到 `stream_recovery` 后同步裁剪 live 文本与段落、移除当前 round 工具卡片和旧 live segment，重建一个 segment，使续写文本从提示之后重新起泡。
- **NDJSON**：输出 `{type:"stream_recovery", attempt, max_attempts, mode, discarded_chars, delay_ms, reason}`。

### 恢复期间的前端一致性

- resume 中断时，被扣住的增量（`combined.slice(visible.length)`）会立即 flush 给前端，避免“历史里有、屏幕上没有”的偏差。
- restart 时 Agent 会：
  - abort 并清空本轮提前执行的只读工具结果（`earlyRuns`），避免重启后的模型调用与旧 `tool_use_id` 错配；
  - 递增 `earlyEpoch`，抑制旧尝试迟到的 `onToolStart`/`onToolEnd`/`onSubTool*` 事件——否则回滚后仍可能冒出“僵尸工具卡片”；
  - 新一轮仍按正常波次调度，重新执行的工具只上报一次。
- 用户取消优先于恢复：等待退避或任一尝试期间中断，抛 `CancelledStreamError` 并携带已产出文本，不再继续恢复。

### 持久化打捞

`Agent.chat` 的 catch 现在同时处理 `CancelledStreamError` 与 `StreamRecoveryExhausted`：把 `partialText` 以纯文本 assistant 消息写入历史并 `persistTurn()`，再上抛错误。这样 `/resume` 与下一次请求看到的内容和用户屏幕上一致，且历史保持 API 合法（纯文本 assistant 不需要 tool_result）。

## 配置速查

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `AGENT_STREAM_RECOVERY_ATTEMPTS` | `4` | 每次逻辑请求的恢复次数上限；`0` 完全关闭 |
| `AGENT_RETRY_BASE_MS` | `1000` | 恢复退避基数（与请求重试共用） |
| `AGENT_RETRY_MAX_DELAY_MS` | `60000` | 单次退避上限 |
| `AGENT_RETRY_JITTER` | `0.25` | 退避抖动比例 |
| `AGENT_STREAM_IDLE_MS` | `60000` | 流空闲看门狗；每次请求重试额外放宽 30s |

## 测试

- `tests/llmRetry.test.ts`：resume 合并与只补发后缀；resume 事件与退避；restart 从原 messages 重发并上报 `discardedChars`；续写中断的增量 flush；400 不重试直接 `StreamRecoveryExhausted`；503 恢复且 `reason=server`；`AGENT_STREAM_RECOVERY_ATTEMPTS=2` 时共 3 次请求后终止；`=0` 关闭；退避期间取消得到 `CancelledStreamError`。
- `tests/llmCancel.test.ts`：resume 等待中取消保留已产出文本；续写尝试中取消按 `mergeText` 去重（Anthropic prefill 追加、OpenAI 从头重发均不产生重复段）。
- `tests/agent.test.ts`：`StreamRecoveryExhausted` 打捞持久化；restart 后旧提前工具的迟到事件被抑制，重新执行仅上报一次。
- `tests/guiRetryE2E.test.ts`：真实 HTTP/SSE——先输出文本与半截 `tool_use` 后断开，GUI 服务端收到 `stream_recovery(restart, discardedChars=9)`，第二次请求正常返回，无 `turn_error`。
- `tests/guiDom.test.ts`：DOM 回滚旧文本与工具卡片，显示中断提示，新文本出现在新气泡。
- `tests/headless.test.ts`：NDJSON `stream_recovery` 字段完整。

## 限制与刻意不做

- **不是 token 级断点续传**：provider 无法从任意 token 继续；resume 仍重新生成，只是把已有文本作为 prefill/续写前缀，省掉重复首段与用户等待。
- **已开始的工具调用一律 restart**：宁可整段重来，也不把半截参数交给工具执行。
- **不做 provider 安全锚点尾部丢弃**（ZCode 的 StreamRecoveryStarted/AnchorSelected/TailDiscarded 更细粒度）；本实现只有 resume / restart 两档。
- **恢复预算按一次 `send` 计算**，不跨回合持久化；进程重启后不再恢复。
- **重叠去重只覆盖尾部 ≤200 字符**：模型若改写前文而非重复尾部，可能出现少量重复文本（可读性受损但不破坏历史结构）。
