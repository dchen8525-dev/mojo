# /undo 冲突检测

## 状态

- 2026-10-22 落地（b42fc3f），规格补于 2026-10-22；同一批补上了 `postExisted=false` 分支的缺陷修复。

## 机制

每次 `write_file`/`edit_file`/`multi_edit` 落盘后，checkpoint 句柄的 `finalize()` 记录：

- `postHash`：agent 写入后文件的 SHA-256；
- `postExisted`：写入后文件是否仍存在（创建后被删除时为 `false`）。

`/undo`（`CheckpointStore.undoLast`）在恢复最新未撤销检查点前：

- 若 `postExisted === false`：当前路径必须仍不存在；被他人重建则**拒绝**。
- 否则用当前文件哈希对比 `postHash`：文件被删除/移动/修改则**拒绝**。
- 旧版检查点（无这两个字段）保持原行为，直接恢复。
- 拒绝时不标记 `restored`，检查点保留；`force: true` 可跳过检查（CLI `/undo -y --force`）。

CLI 对 `UndoResult.conflict` 返回错误提示（不再显示 "undone"），并告知可用
`/undo -y --force` 丢弃后续改动。**默认拒绝**是为了绝不静默覆盖用户或其他进程在 agent
写入之后做出的修改。

## 代码

- `src/checkpoint.ts`（`finalize`、`undoLast`）；`src/agentCommands.ts`（`/undo` 输出与 `--force`）。
- 测试：`tests/checkpoint.test.ts`（文件被修改、被删除后重建两条冲突路径 + force）、
  `tests/agentCommands.test.ts`（冲突提示与 force 透传）。
