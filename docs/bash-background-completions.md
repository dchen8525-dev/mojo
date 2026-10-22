# bash 后台任务完成通知

## 状态

- 2026-10-22 落地（b42fc3f），规格补于 2026-10-22。

## 机制

`bash run_in_background` 启动的任务在 `BackgroundManager` 中记录 `owner`（发起它的会话 id）、
`startedAt`、`endedAt`、`delivered`。进程结束时：

1. 任务进入 `completed` 队列；
2. 下一次 `Agent.chat` 的轮次边界（`drainBackgroundTasks`）调用
   `backgroundManager.drainCompleted(this.sessionId)`，只取**本会话拥有且未投递**的任务；
3. 每个任务以 `<system-reminder event="BackgroundTaskComplete">` 注入一条用户消息，内容包括：
   状态（killed / exit code）、运行秒数、截断后的命令、完整日志路径、日志尾部
   （`readTail`，最多 32KB 读、返回 2000 字符）、以及 `bash_output {id, since}` 提示；
4. 投递后标记 `delivered` 并从队列移除，**每个任务只通知一次**。

`owner` 为空的任务（测试或非会话上下文启动）不会被自动投递，只能通过 `bash_output` 轮询。
后台子代理的完成通知走独立的 `SubagentTaskRegistry`，机制见
[background-subagents.md](background-subagents.md)。

## 设计取舍

通知在轮次边界注入，因此模型无需轮询即可看到「后台跑完了」；但若一轮模型调用仍在进行，
通知会等到下一轮。日志尾部让模型无需立刻调用 `bash_output` 就能判断成败。

## 代码

- 任务与队列：`src/tools/background.ts`（`start(..., owner)`、`readTail`、`drainCompleted`）。
- 接线：`src/tools/bash.ts` 传入 `ctx.sessionId`；`src/agent.ts` 的 `drainBackgroundTasks`。
- 测试：`tests/agent.test.ts`（后台任务投递）、`tests/bash.test.ts`（`bash_output`）。
