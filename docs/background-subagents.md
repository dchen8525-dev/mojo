# 后台子代理（detached runner + 完成提醒）

## 状态

- 2026-10-21 落地（缩水版，不含 pending-message 邮箱与工具事件镜像）。本文是后台子代理行为的规范。

## 启动

- task 工具新增 `run_in_background: true`：worker 的 consent 提示照常先问，随后立即返回任务 id
  （`sub-1`、`sub-2`…）与使用说明，父回合不等待。
- 分离运行**不继承**父回合的 abort signal（回合结束子代理继续跑）；仍受全局并发槽
  （`SUB_MAX_CONCURRENCY = 4`）约束。
- 注册表 `src/taskRegistry.ts` 为模块级单例（与 bash 的 `backgroundManager` 同模式），记录
  `{id, description, kind, startedAt, status, report, delivered}`。

## 报告投递

- agent 在每轮工具循环边界（drainSteer 之后）调用 `drainCompleted()`：已完成且未投递的任务以
  `<system-reminder event="BackgroundTaskComplete">` user 消息注入历史（报告超 4000 字符截头并提示
  task_output 查全文；failed 任务在提醒中显式标注 FAILED）。
- 每个任务只投递一次（`delivered` 标记）；跨回合存活——本轮没跑完，下一轮 `chat()` 的首个 round 边界补投。

## 查询

- `task_output` 工具：无 `id` 列出全部任务（id/状态/描述/耗时）；带 `id` 返回状态，结束时给全文报告
  （20k boundedResult 落盘，failed 置 isError）；unknown id 报错并列出已知 id。
- 任务列表不持久化：进程重启即清空（与 bash 后台任务一致）。

## 有意不移植（ZCode 完整版）

- pending-message 邮箱（运行中转向后台子代理）、子代理工具事件镜像到父 UI、runtime-task 注册表快照。

## 代码

- `src/taskRegistry.ts`、`src/tools/task.ts`（`runSubagent` 提取 + 后台分支 + `taskOutputTool`）、`src/agent.ts`（drain）。
- 测试：`tests/taskBackground.test.ts`、`tests/agent.test.ts`（background task delivery 用例）。
