# 批次 39：会话/日志保留清理 + TUI @ 文件提及补全

状态：已实现（2026-10-23）｜survey 第 7 轮

## A. 会话/日志保留清理（src/retention.ts）

`~/.node-agent/sessions` 与 `~/.node-agent/journal` 此前只增不减（journal 仅在开启时有体积修剪），长期使用后目录无限膨胀。本批次参照 ZCode `adapters/logging/retention.ts` 的日期保留模式，改为按 **mtime（最后活动时间）** 保留：

- **保留窗口**：默认 14 天；`AGENT_RETENTION_DAYS=<n>` 覆盖（`n>=1` 截断为整数天，`n=0` 完全禁用，非法/负值回退默认）。
- **判定标准**：mojo 的会话文件名是随机 hex（无日期编码），ZCode 的文件名日期解析不适用；改用 `lstat().mtimeMs < cutoff`（mtime = 最后一次追加，与会话 `updatedAt` 语义一致）。
- **保护名单**：`keepIds` 中的会话 id 永不删除——按原始 id 与 journal 侧 `sanitizeId`（journal.ts 的 `[^\w.-] → _`、截断 120）两种形态匹配文件名主干（大小写不敏感）。`keepIds` 可为函数，在清理真正执行时求值。
- **容错**：目录不存在/不可读直接跳过；`unlink` 的 ENOENT 视为并发删除成功；其余失败计入 `failedFiles` 不中断扫描。删除前二次 `lstat`：两次读取之间被追加/恢复（mtime 变新）的会话跳过；只删普通文件，符号链接与目录不动。
- **调度**：`scheduleRetentionCleanup` 在启动后延迟 60 秒执行一次（timer `unref`），不阻塞启动；三个入口接线：
  - TUI（runInteractive）：`resolveSession` 后挂，keep 当前会话 id；
  - print 模式（runPrint）：同上；
  - GUI（runGui）：传 `() => [currentSessionId()]`，保护清理执行时 GUI 正打开的会话（包括调度之后才 resume/打开的）。
- **journal 体积修剪不受影响**：已有的 64MB/200 文件预算照常工作，天数保留是叠加维度。

## B. TUI @ 文件提及补全（src/mentions.ts + src/ui/app.tsx）

TUI 提交路径早已通过 `expandFileReferences`（commands.ts 的 `AT_RE`）把 `@path` 内联为 `<file>` 块，GUI 也有拖拽附件；本批次补齐 TUI 的**输入期补全 UX**：

- **触发**：草稿以 `@token` 结尾（`@` 位于行首或空白后，token 不含空白，可为空 = 列出全部）时打开建议面板。`@"token` 表示带空格的进行中提及：未闭合引号仍触发补全，已闭合引号视为最终文本、不再补全。
- **引号**：路径含空格/逗号/分号/括号时，补全自动写成 `@"my file.txt"`；文件名本身含 `"` 时不加引号，避免产生无法解析的 token。
- **路径索引**（`listWorkspacePaths`）：
  - git 仓库内用 `git ls-files --cached --others --exclude-standard`（含未跟踪未忽略文件），5 秒超时；stdout 按 Buffer 分片收集后统一 UTF-8 解码（多字节字符跨 chunk 不乱码），上限 8 MiB，超限报错；
  - 无 git/失败时退回有界目录遍历（深度 8、上限 5000 项、跳过 `.git`/`node_modules`/`.svn`/`.hg`）；
  - 祖先目录一并入索引（`kind: "directory"`），`@src/` 可继续补全；
  - 按 cwd 缓存 30 秒（LRU 上限 8 个 cwd）。
- **排序**：文件名前缀 > 路径前缀 > 子串 > 空查询，同分取更短路径再按字典序；上限 50 条。
- **键盘**：↑/↓（或 Ctrl+P/N）移动选中；Tab/Enter 补全——文件补全为 `@路径␣`（面板关闭），目录补全为 `@路径`（无尾空格，token 变化后面板自动按新 token 重查）；Esc 关闭并抑制同一 token，token 变化后自动恢复。
- **与现有键位无冲突**：ink-text-input 自身忽略 ↑/↓/Tab；Enter 走 TextInput 的 onSubmit，在提交入口处检测面板打开即转为补全，不会误发回合；Esc 分支排在"busy 中断"与"历史面板"之前。
- 补全只编辑草稿文本；文件内容仍由提交时的 `expandFileReferences` 统一内联：
  - 词法包含 + `realpath` 复查，拒绝凭据文件（`isSensitivePath`）与指向仓库外的符号链接；只接受普通文件（FIFO 等不会阻塞打开）。
  - 读取上限为剩余预算 +1 字节，含 NUL 的二进制跳过；按字节预算截断并在 UTF-8 边界回退（不产生 U+FFFD），只有真正截断才追加 `[... truncated]`。
  - `<file path="...">` 的属性做转义，路径中的引号不能闭合属性。

## 测试

- `tests/retention.test.ts`（9）：窗口判定（20/30 天删、1/2 天留）、keepIds 双形态与函数形式保护、删除前二次 stat 跳过、retentionDays 解析矩阵、0 禁用、env 覆盖、非 jsonl/缺失目录忽略、schedule 延迟回调（注入 setTimeout + expect.poll）。
- `tests/mentions.test.ts`（13）：@token 触发解析（行首/空白后/词中/含空白拒绝、空 token、未闭合引号）、三级排序与上限、文件 vs 目录补全替换、含空格路径自动加引号、滑窗选中、无 git 目录遍历（含 node_modules 跳过）、git 仓库路径 + 30s 缓存命中、多字节路径分片解码。
- `tests/commands.test.ts`：精确字节预算不误截断、多字节截断不产生 U+FFFD、`.netrc` 拒绝、符号链接逃逸拒绝（非 Windows）。

## 验证

`npx vitest run`：88 文件 / 1221 通过 / 7 跳过（新增 16）；`npm run lint`、`npm run build` 全绿。
