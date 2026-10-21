# 超大工具结果落盘（boundedResult）

## 状态

- 2026-10-21 落地（8a4509e）。本文是工具结果上限行为的规范。

## 机制

- `boundedResult(text, max, label)`：文本 ≤ max 原样返回；超过时把**全文**写入
  `os.tmpdir()/node-agent-output/<label>-<ts>-<rand>.txt`，返回头 75% + 尾 20%（head+tail 截断）+ 指针行
  （含路径，提示用 read_file 分页读取）。落盘失败（目录不可写等）退化为纯截断，不报错。
- 与单独 `truncate()` 的区别：被丢弃的中段可恢复，而非永久丢失。

## 转换的调用点（不可恢复 → 可恢复）

- MCP 工具结果（`src/mcp.ts`，label `mcp-result`）
- 子代理报告（`src/tools/task.ts`，20k 上限，label `subagent-report`——子代理上下文随任务销毁，落盘是唯一找回途径）
- read_file（`src/tools/read.ts`）、grep 命中（`src/tools/grep.ts`，formatHits 改 async）、git_diff（`src/tools/git.ts`，沿用调用方 maxChars）

## 有意保留旧行为的调用点

- bash（已有自己的落盘 + 尾部优先）、web fetch/search（显式可重跑的上限参数）、multi_edit/write 的 diff
  （权限确认预览，必须完整展示）、bash_output（offset 分页）、lsp 诊断（可再生）、skill（自有上限）。

## 代码

- `src/artifacts.ts`；测试：`tests/artifacts.test.ts`。
