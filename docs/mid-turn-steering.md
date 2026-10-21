# 回合中段转向（steering）

## 状态

- 2026-10-21 落地（327ea78）。本文是运行中回合接收用户输入的规范。

## 行为

- 回合运行中收到用户输入时，`Agent.steer()` 将其入队并立即返回 true；无运行回合返回 false，调用方走正常 `chat()`。
- 队列在每轮工具循环边界（下一轮模型调用前）排空：转向消息以普通 user 消息追加进历史，模型在下一轮即可看到。
- 模型输出被 token 上限截断时，先处理转向再继续，避免带着未消费输入结束回合。
- 回合失败/中止时清空队列：排队输入绝不自动重放进下一回合。

## 界面

- TUI：排队成功在 transcript 打一条备注。
- GUI：`/api/chat` 在回合运行时接受输入，返回 `202 {queued:true}` 并广播 `steer` SSE 事件（旧版返回 409）。

## 代码

- `src/agent.ts`（`steer` / `drainSteer`）；`src/gui/server.ts`、`src/ui/app.tsx`。
- 测试：`tests/agent.test.ts`（steer 用例）、`tests/guiServer.test.ts`。
