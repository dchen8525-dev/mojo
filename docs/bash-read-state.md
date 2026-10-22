# bash 与读态同步（cat 回填 / formatter 失效）

## 状态

- 2026-10-22 落地（本批）。与 [read-before-edit-guard.md](read-before-edit-guard.md) 配套。

## 为什么

读前编辑守卫只认识 `read_file` 建立读态。模型经常先用 `cat`/`type` 看文件，
如果守卫不认，就会迫使它无谓地再读一遍；反过来，formatter 或重定向改写文件后，
旧读态应立即失效，而不是等到下一次编辑才由 mtime 检查发现。

## 回填（bash → 读态）

命令成功（退出码 0 且未被杀）后，`syncBashFileState` 解析**简单命令**：

- 支持的查看器：`cat`、`type`、`head`、`tail`、`Get-Content`/`gc`。
- `cat`/`type`/`Get-Content` 默认记为**完整读**；`head`/`tail` 与
  `-TotalCount/-First/-Head/-Tail/-Last/-ReadCount` 记为**部分读**。
- 若输出被 `max_output` 截断，完整读降级为部分读（部分读可编辑，但 `write_file`
  整体覆盖仍要求完整读）。
- 含管道、重定向、`;`/`&&`、命令替换等复合语法时**不解析**——其输出不是忠实的文件视图。
- 只记录真实存在且为普通文件的路径。

## 失效（写操作 → 读态）

- 检测到常见 formatter（prettier/eslint/gofmt/rustfmt/black/cargo fmt/clang-format…，
  见 `isFormatterCommand`）时清空整个会话读态，并在工具结果追加提示：
  编辑前需重新读取。无法知道 formatter 改了哪些文件，宁可多读。
- 解析到的重定向目标（`> out`、`2>> log`）逐路径 `FileStateStore.invalidate`；
  其余外部改写仍由 mtime/size 新鲜度检查兜底。

## 代码

- `src/tools/bashFileState.ts`；`FileStateStore.invalidate`（`src/fileState.ts`）；
  接线于 `bashTool` 的成功分支（`src/tools/bash.ts`）。
- 测试：`tests/bashFileState.test.ts`。
