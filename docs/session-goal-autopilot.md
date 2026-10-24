# 会话目标自动续跑（批次 35）

状态：已实现（2026-10-23）｜来源：ZCode 对标 survey 第 3 轮 #14

## 背景与范围

长任务（“把迁移做完”“让 CI 变绿”）往往要跨多个回合：模型每轮只推进一步，用户得反复输入“继续”。ZCode 的 goal autopilot 把目标变成会话级状态：每轮结束后由一次**独立校验调用**判断目标是否完成，未完成就自动排队下一轮，直到完成、失败或触达预算/次数上限。

本批次实现完整自驱版：目标持久化 + 每轮后 LLM 完成校验（含 nextAction）+ 空闲自动续跑 + token 预算/续跑上限 + `/goal` 命令 + GUI/Ink/NDJSON 三端呈现。代价是每轮多一次小模型调用（校验器只读目标 + 上轮输出，不携带工具历史）。

## 状态模型

`src/goal.ts` 拥有状态形状、容错解析、提示词与命令解析；循环归 `Agent`。

```ts
interface SessionGoal {
  objective: string;            // 单行目标，最长 4000 字符
  status: "active" | "paused" | "completed" | "cancelled";
  tokenBudget: number | null;   // null = 不限
  tokensUsed: number;           // 主回合/校验器的 input + output + 缓存读写累计
  continuations: number;        // 已排队的自动续跑次数
  maxContinuations: number;     // 默认 10，硬上限 50
  createdAt / updatedAt: string;
  note?: string;                // 暂停/完成原因（≤600）
  nextAction?: string;          // 校验器给出的下一步（≤600）
}
```

- **容错**：`sanitizeGoal` 永不抛错；目标为空 → 整条记录丢弃；未知 status → `paused`（损坏文件绝不能自动开跑）；时间戳非法 → 当前时间。
- **状态机**：`setGoal` → active；`pauseGoal` 取消队列中续跑；`resumeGoal` 重新 active 并立即排队；`completeGoal`（含 `/goal done`）清空 nextAction；`clearGoal` 删除持久化字段。`active` 与 `paused` 之外的状态不再注入系统提示。
- **审计**：每次变更都写回会话文件并广播事件；持久化失败只影响落盘（best-effort），内存状态继续生效。

## 自动循环

```
user turn / continuation turn
  └─ afterTurnGoal(finalText, turnTokens)
       ├─ goal.status !== "active" → 返回
       ├─ tokensUsed += turnTokens；persist
       ├─ planMode → pause("plan mode is on")
       ├─ autopilot 被禁用（print 模式 / AGENT_GOAL_AUTOPILOT=0）→ 仅记账
       ├─ turnStopped（成本预算/工具迭代上限）→ pause
       ├─ 预算耗尽 / 续跑到顶 → pause
       ├─ onGoalChecking 事件
       ├─ verifyGoal：一次 llm.send(...)，60s 超时
       │    ├─ 解析失败/超时/抛错/中断 → pause + note
       │    ├─ done=true → completed + note，取消队列
       │    └─ done=false → nextAction 落盘，enqueue 下一轮
       └─ runtimeQueue.enqueue("send_prompt", continuationPrompt, "goal")
```

- **续跑不是递归**：续跑提示进入统一的 `RuntimeCommandQueue`，由宿主的 pump 消费（GUI `pumpRuntimeQueue()` / Ink `pumpQueue`），因此不会重入 `chat`，也不会在 UI 忙时插队。
- **续跑轮是合成轮**：`Agent.chat` 第 5 参数 `{ goalContinuation: true }` 时跳过 `UserPromptSubmit` hook、记忆召回、`#sess_` 引用提示、@ 文件展开、斜杠命令解析与会话自动命名；也不计入“首轮真实请求”，不写 Ink 输入历史。用户消息仍是 `<system-reminder event="GoalContinuation">`，转写工具可将其识别为注入上下文。
- **用户输入优先**：任何真实用户消息（非续跑）都会先 `cancelBySource("goal")`，把排队中的自动续跑标记为 cancelled；正在运行的回合不受影响。
- **失败即暂停**：回合抛错/中断时先记账再 `pauseGoal`（“turn interrupted / turn failed”），队列中的续跑一并取消；Salvage 逻辑照常保留已输出的文本。
- **计划模式**：`queueGoalContinuation` 与 `afterTurnGoal` 都会在 planMode 为真时暂停目标（note `paused automatically: plan mode is on`）。计划模式的意义是先审计划再执行，自动起回合会绕过审批门。
- **成本与上限**：`tokensUsed` 统计 provider 的全部输入 token（新鲜输入 + 缓存读/写）与输出。缓存命中只是折扣价，仍占上下文与预算；漏算会让缓存型会话的预算长期虚低。成本台账另记 cacheRead/cacheWrite，两者不混用。`turnStopped` 由成本预算熔断或工具迭代上限设置，自动循环据此暂停。

## 校验器

- 系统提示 `GOAL_VERIFIER_SYSTEM` 要求只回一个 JSON：`{"done":boolean,"nextAction":"...","reason":"..."}`。
- 输入只有：目标、上一轮 nextAction、累计 token、**最近一次 assistant 输出**（≤8000 字符，超出截断）。刻意不传工具调用历史：校验器判断“最新回合是否推进到目标”，不重放整个会话。
- 解析容忍 ```json 代码围栏与前后说明文字；`done` 允许布尔字符串。无可用判定 → 暂停并提示 “completion verifier returned no usable verdict”。
- 校验调用 60s 超时会中止请求并暂停；用户中断会转发 abort。用量（含缓存读/写）计入 `tokensUsed`、成本台账与 `onUsage`。
- 校验器调用本身不触发新一轮校验（只有回合结束才进 `afterTurnGoal`）。
- **标签注入防护**：objective/nextAction/note 与校验器引用的上一轮输出在拼进 `<goal_state>` / `<latest_turn>` 前，闭合标签统一转义为 `&lt;...`；文件或网页里引用的目标文本不能提前结束提醒块、冒充顶层指令。
- **陈旧目标**：校验返回后先比对目标身份（`this.goal !== goal`）；等待期间目标被替换或清除时，不把成本与判定记到旧目标上。

## `/goal` 命令

```
/goal                                   # 状态
/goal <objective> [--budget <tokens>] [--max <n>]
/goal pause | resume | done | clear
/goal budget <tokens|off>               # off 移除预算
/goal max <n>                           # 1–50
```

- 别名：`hold`=pause、`continue`=resume、`complete`=done、`cancel|stop`=clear；`set` 前缀可省略。
- `--budget` 支持 `--budget=5000`、`-b`、`--tokens`；`off|none|0` 表示不限；非法值/`max 0`/`max 99` 报 usage 错误。
- `open` 状态输出包含 token 进度、续跑次数、nextAction、note，以及下一步该敲什么。
- `/goal budget` 调低到已超支、`/goal max` 调到 ≤ 已续跑次数时，active 目标立即暂停。
- 设置新目标会先取消旧目标排队的续跑，再排队首轮（“starting the goal (1/N)”）。

## 四端呈现

| 端 | 行为 |
| --- | --- |
| CLI / Ink | 系统行 `[goal] <note> · <summary>`；校验中显示 `[goal] verifying whether the objective is complete…`；pump 消费续跑并以 `↻ <summary>` 标注轮次 |
| GUI server | SSE `goal_changed {goal,note}` / `goal_checking {}`；`/api/state` 快照带 `goal`；`turn_start` 对续跑带 `goal:true`；`command_dequeued` 带 `source`，续跑显示为 `自动续跑 · <objective>` |
| GUI 客户端 | 顶栏“◎ 目标”胶囊：active 显示 `n/max`，paused `Ⅱ`，completed `✓`，cancelled `×`；弹层展示目标、token 进度、自动续跑次数、下一步、note，并提供暂停/继续/清除（走 `/api/chat` 的 `/goal ...`） |
| NDJSON（print） | `{"type":"goal_changed","goal":{objective,status,token_budget,tokens_used,continuations,max_continuations,updated_at,next_action?,note?},"note"?}`；清除时 `goal:null`；`{"type":"goal_checking"}` |

`/goal` 变更发生在回合之外，没有 per-turn events 通道，因此 `Agent.onGoalChanged` 属性由宿主（GUI `GuiRuntime.attach`、Ink 在 runTurn 内优先用 events）兜底广播。

## 持久化与 fork

- 目标存在会话 meta 头部的 `goal` 字段（与 todos 同层），`saveGoal(id, null)` 删除字段。
- `Agent.loadGoal()` 在会话启动/切换时读取；先 `cancelBySource("goal")`，上一会话排队的续跑绝不泄漏到新会话。损坏字段由 `sanitizeGoal` 丢弃，不影响 resume。
- `forkSession` 携带当前 goal（重写 meta 时一次写入），fork 出来的分支继续同一目标。
- **恢复不自动起跑**：加载到 active 目标只恢复状态，不自动排队续跑，避免打开会话/切换项目时产生意外成本；循环在下一轮用户消息后继续，或由 `/goal resume` 显式启动。

## 关闭开关

- `AGENT_GOAL_AUTOPILOT=0`：只记账、不校验、不续跑。
- print 模式（`-p`）启动时调用 `disableGoalAutopilot()`：没有宿主 pump，不能承诺自动续跑；`/goal` 状态仍可查看。
- 计划模式：自动暂停（见上）。

## 测试

- `tests/goal.test.ts`（13）：状态构造/容错解析、预算与剩余量、摘要/状态块、续跑提示、校验 JSON 解析（围栏/散文/坏值）、命令解析（别名、flag、非法值）。
- `tests/agent.test.ts`（goal 13）：首轮排队与持久化、提示注入与完成判定、nextAction 落盘、续跑上限、预算耗尽（含缓存 token 计入）、校验不可解析、中断/失败暂停并取消队列、真实输入取消续跑、pause/resume/complete/clear、预算/上限调整、恢复持久化目标、**plan 模式暂停**。
- `tests/agentCommands.test.ts`（4）：`/goal` 启动（含 `--budget/--max`）、状态/暂停/继续/完成/清除、预算与上限调整（`off`→null）、非法输入。
- `tests/session.test.ts`（5）：goal 写入/读取、null 清除、损坏记录丢弃、fork 携带、缺失会话返回 false。
- `tests/runtimeQueue.test.ts`（1）：`cancelBySource` 只取消该来源的 accepted 命令。
- `tests/guiServer.test.ts`（3）：`/api/state` 暴露 goal、SSE 广播序列、pump 以 `{goalContinuation:true}` 消费队列并标记完成。
- `tests/guiDom.test.ts`（2）：目标胶囊/弹层渲染与暂停命令、`goal_changed` 更新与清除隐藏。
- `tests/headless.test.ts`（1 + 映射用例）：`goal_changed`/`goal_checking` 字段与清除时 `goal:null`。

## 刻意不做

- 不自动在会话恢复时续跑（成本不可预期）；不跨会话共享目标。
- 不支持多目标/目标栈；新目标替换旧目标。
- 校验器不读取工具结果或完整转写，只判最新回合；需要更多证据时由 nextAction 让主 agent 自行复核。
- 子代理不参与 goal autopilot（子代理调用不触发目标校验）。
- 不按目标切换模型/权限；autopilot 仍受当前 permission 模式约束（计划模式即暂停）。
- 续跑轮不重新展开 `@` 引用、不触发 UserPromptSubmit hook：它是系统生成的消息，不是用户输入。
