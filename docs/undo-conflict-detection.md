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

移动（apply_patch 的 `*** Move to:`）是双路径编辑：checkpoint 额外记录 `movedTo` 与
`movedToHash`，并在源文件 unlink **之后** finalize，因此源记为 `postExisted=false`
（agent 自己的删除不会再被误判成用户改动）。撤销时：

- 先按上面的规则校验源路径；
- 再校验目标副本：存在且哈希不等于 `movedToHash` → 拒绝（`the moved-to file was
  modified after the agent's move`），绝不清掉用户改过的副本；
- 通过后恢复源内容，并删除目标副本；目标已被用户删掉则只恢复源。

CLI 对 `UndoResult.conflict` 返回错误提示（不再显示 "undone"），并告知可用
`/undo -y --force` 丢弃后续改动。**默认拒绝**是为了绝不静默覆盖用户或其他进程在 agent
写入之后做出的修改。

## 代码

- `src/checkpoint.ts`（`finalize`、`undoLast`）；`src/agentCommands.ts`（`/undo` 输出与 `--force`）。
- 测试：`tests/checkpoint.test.ts`（文件被修改、被删除后重建两条冲突路径 + force；move 的
  源恢复/目标删除、目标被改后拒绝）、`tests/agentCommands.test.ts`（冲突提示与 force 透传）。
