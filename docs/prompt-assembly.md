# 系统提示词装配（turn completion / 工具门控 / 仓库快照）

## 状态

- 2026-10-22 落地（本批）。本文是系统提示词内容的规范。

## 结构

系统提示词仍分 `stable`（缓存稳定前缀）与 `volatile`（易变尾部），见
[system-prompt-cache-split.md](system-prompt-cache-split.md)。本次新增三块内容：

1. **Turn completion 契约**（`src/prompts.ts` 的 `TURN_COMPLETION`）：一轮完成的定义
   ——请求全部处理且结果经过验证（测试/构建/诊断）、完成当前工作前不中途停下、受阻时
   说明尝试与错误而不是静默放弃或重复同一调用、结尾给出变更/验证/遗留事项的简短总结。
2. **工具门控 guidance**（`toolGuidance(toolNames)`）：仅当对应工具在本轮激活时才注入：
   `bash` → shell 规范；`write_file`/`edit_file`/`multi_edit` → 编辑与诊断规范；
   `task` → 子代理分工；`web_search`/`web_fetch` → 来源与不可信内容；
   `git_*` → 优先用专用 git 工具；存在未暴露的延迟工具 → `tool_search` 提示。
   只读 `read_file` 不会触发编辑规范。
3. **仓库快照**（volatile）：`git status --short --branch` 之外新增最近 5 条提交
   （`git log -5 --oneline`，3s 超时；非仓库/无提交时省略或标注 `(no commits yet)`）。

## 缓存

`Agent.systemPromptCache` 以**激活工具名列表**为 key。`tool_search` 在中途暴露延迟工具、
或 plan mode 切换导致工具集变化时，下一轮重建提示词；工具集不变则整个回合复用同一份
stable/volatile，保持 provider 前缀缓存命中。

## 代码

- `src/prompts.ts`（`TURN_COMPLETION`、`toolGuidance`）；`src/agent.ts`（`buildSystemPrompt`、
  `systemPrompt` 缓存、volatile 快照）。
- 测试：`tests/prompts.test.ts`、`tests/agent.test.ts`（含 plan mode 下 shell/编辑块缺席）。
