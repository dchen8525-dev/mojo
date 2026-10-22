# 统一运行时命令队列（runtime command queue）

- 状态：已完成（2026-10-22，批次 24）
- 对应改进计划条目：#5
- 参考：ZCode 的 `ZCodeTaskRuntimeCommand`（pendingCommands + accepted/running/failed 状态机）与 "running-send-now" 语义

## 目标

忙碌会话收到的输入不再只有两条路（steer 注入 / 409 拒绝），而是进入一个带显式生命周期的
统一命令队列：排队为独立后续回合是默认行为，插话（steer）成为显式选择。

## 设计

`src/runtimeQueue.ts` 的 `RuntimeCommandQueue`：

- 命令类型：`steer`（注入运行中回合的下个轮边界）与 `send_prompt`（当前回合结束后作为完整新回合执行）。
- 状态机：`accepted → running → done | failed`；`cancelled` 可从 accepted 直达（running 不可取消）。
- 记录字段：id（cmd-N 自增）、prompt、images?、source、error?、enqueuedAt/startedAt/finishedAt。
- 上限：accepted 命令最多 20（`MAX_RUNTIME_COMMANDS`），超出 `enqueue` 返回 null（调用方决定 UX，当前 GUI 返回 429）。
- 历史：settled 记录保留最近 20 条，live 记录永不裁剪。
- `onChange` 回调用于 UI 订阅（当前未接线，状态经 REST 查询）。

## 接线

### Agent（src/agent.ts）

- `steerQueue` 数组删除，`Agent.steer()` 改为向 `runtimeQueue`（公开只读）enqueue `steer` 命令；
  `drainSteer()` 逐条 `take("steer")` 并在注入后 `complete(id)`。
- 失败/中止的回合仍然丢弃 steer 命令（`cancelAll("steer")`），语义与旧实现一致。
- CLI 行为不变（仍走 steer）。

### GUI 服务器（src/gui/server.ts）

- `POST /api/chat` 忙碌时：
  - `steer: true` 且 command 非忙 → `agent.steer()`，202 `{queued: "steer"}`（409 当 agent 拒绝）；
  - 默认 → enqueue `send_prompt`，202 `{queued: "pending", id}`，SSE `command_queued` 广播；
    队列满 → 429。`switching` 期间仍 409（排队命令会随旧 agent 一起消失，不允许）。
- `pumpRuntimeQueue()`：在 handleChat / runCommand 的 finally 中触发；FIFO 逐条
  `take("send_prompt")` → SSE `command_dequeued` → `handleChat()`（同一路径：自定义命令、
  slash 命令、文件引用展开全部复用）→ `complete()`。重入折叠；每次循环前重新检查
  busy/commandBusy/switching。
- `GET /api/queue`：命令列表；`DELETE /api/queue/:id`：取消 accepted 命令（SSE `command_cancelled`）。
- `/api/abort`：终止当前回合/命令的同时 `cancelAll("send_prompt")` 并广播"已取消 N 条排队消息"
  —— 停止即全停，语义可预期。

### GUI 前端

- `#steer-toggle`（"插话"按钮，composer 工具条）：默认关 = 忙碌时发送排队为后续新回合；
  开 = 忙碌时发送带 `steer: true` 注入当前回合。状态存 `state.steerMode`。
- send() 按响应区分 toast：`queued: "pending"` → "已排队，将在当前回合结束后作为新回合执行"；
  `queued: "steer"` → "已加入本轮插话，将在下个间隙生效"。
- 排队命令执行时走正常 turn_start/turn_end 事件，transcript 自然呈现，无额外渲染路径。

## 测试

- tests/runtimeQueue.test.ts（9）：FIFO、类型隔离、状态机、取消规则、cancelAll 过滤、
  容量上限、裁剪保 live、onChange、list 拷贝。
- tests/guiServer.test.ts：默认排队（queued:"pending" + 列表断言）、显式 steer、
  排队命令在当前回合后真实执行（假 chat 两次调用 + done 状态）、DELETE/abort 取消；
  原有 409 断言更新（switching 仍 409；commandBusy 下 chat 202+pending）。
- 实机验证（真实 DeepSeek turn）：数数回合运行中经 MutationObserver 注入第二条，
  `/api/queue` 显示 `cmd-1 done`，transcript 中第二条作为独立回合执行并回复；
  #steer-toggle 切换正常。

## 已知省略

- 排队命令状态仅在 REST 可查（GET /api/queue），前端暂无队列面板。
- 无每客户端区分：任何客户端的 DELETE 都能取消任何排队命令（单用户本地工具）。
- CLI（Ink）忙碌输入仍为 steer，不排队后续回合。
