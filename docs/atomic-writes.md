# 原子写入（write / edit / multi_edit / session）

## 状态

- 2026-10-22 落地（本批）。取代 session 模块内的私有实现。

## 机制

`atomicWriteFile(file, data, mode?)`（`src/atomicWrite.ts`）：

1. 在目标同目录创建临时文件 `<file>.<pid>.<rand>.tmp`；
2. 写入并尽力 `fsync`（网络盘不支持时忽略）；
3. `rename` 覆盖目标；Windows 上对 `EPERM/EBUSY/EACCES` 做 5 次短退避重试；
4. 任一步失败则删除临时文件并抛出原错误。

崩溃只会留下旧内容或新内容，不会产生半截文件、也不会有残留临时文件（异常路径清理）。

### 权限与符号链接

- 显式 `mode` 优先（session 文件固定 `0600`）；`createSession` 新建会话文件时同样显式
  `0600`，并把 sessions 目录收紧到 `0700`；
- 覆盖已有文件时沿用其权限位；新文件走默认 `0666 & ~umask`；
- 目标是符号链接时**直接写穿**（与 `fs.writeFile` 语义一致），而不是把链接替换成普通文件。

## 调用点

- `write_file`、`edit_file`、`multi_edit` 的落盘；
- `src/session.ts` 的 `rewriteMessages` / `writeMeta`（`0600`）。

## 代码

- `src/atomicWrite.ts`；测试：`tests/atomicWrite.test.ts`（创建/覆盖/无残留/权限位/符号链接，
  平台相关项在 Windows 跳过），写入路径由 `tests/fileGuard.test.ts`、`tests/session.test.ts` 覆盖。
