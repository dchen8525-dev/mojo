# 工作区回滚（/rewind，workspace checkpoint rewind）

- 状态：已实现（2026-10-22）
- 模块：`src/checkpoint.ts`（rewindTo）、`src/agent.ts`（rewindToCheckpoint）、`src/agentCommands.ts`（/rewind）、GUI 命令面板
- 测试：`tests/checkpoint.test.ts`（rewind 7 条）、`tests/agentCommands.test.ts`（3 条）

## 动机

已有的 `/undo` 是单文件 LIFO：一次只回滚最近一次 agent 修改。用户往往想回到"某个
时间点之前的工作区"——比如 agent 连改了六个文件后想整体退回第三次修改前。ZCode 的
做法不是全量快照，而是**按编辑粒度的 before 快照 + 事件重放**：回滚到检查点 N 就是
把 N 及之后的所有活跃检查点按序折叠加起来恢复。mojo 已有的 per-file checkpoint
（每次 write_file/edit_file 前捕获 pre-image + finalize 记录 postHash）正好就是这个
模型的一半，缺的只是"多检查点重放"这一层。

## 语义

`CheckpointStore.rewindTo(targetId, { force?, dryRun? })`：

- **回滚计划** = 目标检查点**自身及其后**所有未恢复（`!restored`）的条目。检查点 N
  记录的是第 N 次编辑前的镜像，因此"回到 #N 之前"必须同时撤销第 N 次编辑。
  已被 `/undo` 消费的条目不参与（其效果已被回滚）。
- **冲突检测**：按文件取计划内**最新**条目的 `postHash`/`postExisted`，与当前文件
  哈希比对——不匹配（或该删除的文件被重建）则整个回滚拒绝，逐文件给出原因。
  未 finalize 的旧式检查点无法验证，直接放行。`--force` 完全跳过检测（与 /undo 一致）。
- **恢复**：按文件取计划内**最早**条目的 pre-image（`existed=false` 的文件被 agent
  创建过 → 回滚即删除）。`--force` 恢复时同样逐文件执行。
- 应用后计划内所有条目标记 `restored=true`；此后 `/undo` 会继续回退更早的检查点
  （但其 postHash 冲突检测会正确拒绝，除非 --force）。
- `dryRun`（预览）不触碰文件、不标记条目。

## 命令

```
/rewind                 列出本会话全部检查点（id / 时间 / 工具 / 文件）
/rewind <id|latest>     预览：列出将被回滚的文件与动作
/rewind <id|latest> -y  应用
/rewind ... --force     跳过冲突检测
```

GUI 的命令面板（Ctrl/Cmd+P）与 `/` 调色板均暴露 `/rewind`；实现走统一的
`runAgentCommand` 路径，GUI 无需新 API。会话切换（/resume /clear /fork）后
CheckpointStore 随 sessionId 重建，回滚计划天然按会话隔离。

## 与 ZCode 的差异（有意简化）

- **不做对话回滚 / fork 分支**：ZCode 的 `RewindScope` 支持同时回滚对话历史
  （append-only branch cut）或 fork 子会话——mojo 的会话分叉是独立的 backlog 项
  （survey #7），不在本批次。`/rewind` 只动文件，不动消息。
- **无 CheckpointCreated 事件溯源**：mojo 的 index.json 已是事件记录，重放即列表，
  无需单独事件流。
- **无 artifact 存储/structuredPatch**：pre-image 是原始字节拷贝，预览只列文件级
  动作，不做逐文件 diff 面板。

## 已知边界

- bash 产生的文件变更不被捕获（与 /undo 相同的限制），回滚预览也不会提及它们——
  ZCode 在 UI 中标记 `bash_ignored`，mojo 暂只在文档说明。
- 快照被 prune 掉的极老检查点（超出 MAX_CHECKPOINTS=50）若出现在计划内，恢复时
  跳过该文件（无 pre-image 可用），不中断整体回滚。
