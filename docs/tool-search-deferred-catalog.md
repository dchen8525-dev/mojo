# tool_search 延迟工具目录

## 状态

- 2026-10-21 落地（9b72828）。本文是工具渐进披露机制的规范。

## 延迟标记

- MCP server 暴露的工具数 > `MCP_DEFER_TOOLS`（12）时，该 server 的全部工具标记 `deferred: true`：
  不进入模型可见 tool 列表，一个 40 工具的 server 每轮只花一个 tool_search 的成本。
- 内置工具不延迟。

## tool_search 工具

- 检索隐藏目录：查询按 token 对名称（权重 8）与描述（权重 2）打分，命中即自动暴露（默认上限 8）；
  `select:name1,name2` 按精确名暴露并报告未找到项。
- 无隐藏工具 / 无匹配 / 空查询时返回引导性文案（换更宽泛关键词、用 server 名、或 select 精确名）。
- `isReadOnly: true`、`parallelSafe: true`，始终可见。

## 暴露语义

- 暴露集合按**会话**隔离（`tools/index.ts` 的 `Map<sessionId, Set<name>>`）：同一进程里的 GUI 会话
  切换、MCP server 的多个 `agent_chat` 不会继承彼此的发现结果；`""` 键供无会话调用方（tool_search
  单测、直接调用）使用。暴露后工具立即进入该会话下一轮的 tool 列表并可直接调用。
- 直接调用未暴露的延迟工具 → 错误并提示先用 tool_search（不报 unknown tool）。
- plan 模式同样只列出已暴露的延迟工具（此前列出全量只读工具、直接调用却被门禁拒绝）；tool_search
  在 plan 模式仍可用，暴露后下一轮即可调用。
- MCP 断开（`unregisterToolsByPrefix`）连带清除**所有会话**中该前缀的暴露状态。
- 已发现的名称随会话元数据持久化（批次 38，`SessionMeta.exposedTools`）；/resume 时只恢复该会话
  自己的列表，未知/非 deferred 名称静默跳过。

## 代码

- `src/tools/toolSearch.ts`；暴露集合 `src/tools/index.ts`；标记 `src/mcp.ts`（`wrapTool`）。
- 测试：`tests/toolSearch.test.ts`（按会话隔离用例）、`tests/agent.test.ts`（deferred tools、
  plan 模式工具表用例）。
