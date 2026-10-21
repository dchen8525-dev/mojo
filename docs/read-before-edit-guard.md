# 写前新鲜度守卫（read before edit）

## 状态

- 2026-10-21 落地（62f4caf）。本文是文件编辑前读取状态检查的规范。

## 记录

- `FileStateStore` 为每次 read_file 记录 `{mtimeMs, size, full}`；完整读到文件尾记 `full=true`，带 offset/limit
  的部分读取记 `full=false`。
- 工具自身写文件后调用 `recordCurrent` 重新采样，连续编辑不要求重复读。
- 会话切换（/resume、/clear、fork 从头开始）时 `clear()`：模型上下文已重置，记录必须同步作废。

## 检查

| 操作 | 要求 | 不满足时 |
| --- | --- | --- |
| write_file 覆盖已存在文件 | **完整读取**（部分读取视为未读） | 拒绝，提示先 read_file 全文 |
| edit_file | 任意读取即可（old_string 匹配本身提供保护） | 拒绝，提示先 read_file |
| write_file 新建文件 | 无要求 | — |

- 磁盘状态与记录不符（mtime+size 失配，外部改动）→ 判为 stale，同样拒绝。
- 文件不存在或为目录 → 不产生记录，检查通过（交给后续 stat 错误处理）。

## 豁免

- `multi_edit` 不要求预读（定位为经单次 diff 确认的 codemod），但对每个写过的文件记录状态，使后续
  edit_file 无需重读。

## 代码

- `src/fileState.ts`；`src/tools/read.ts`、`src/tools/write.ts`、`src/tools/multiEdit.ts`。
- 测试：`tests/fileGuard.test.ts`。
