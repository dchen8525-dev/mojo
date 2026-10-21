# 压缩与微压缩

## 状态

- 2026-10-21 微压缩落地（f21165b）。本文是上下文压缩两级策略的规范。

## 两级策略（每轮工具循环开始前检查）

1. **微压缩（prune-only）**：估算 token 超过 `contextWindow * MICROCOMPACT_RATIO`（0.7）时，把保护窗口
   （`MICRO_PRUNE_PROTECT_LAST = 6` 条消息）之外的旧 tool_result 替换为带标记的占位短文。无 LLM 调用，
   通常足以推迟全量压缩。
2. **全量压缩**：超过 `COMPACT_RATIO`（0.75）时触发。优先用 LLM 摘要压缩旧交换；摘要失败或结果不足时
   回退为整交换截断（drop）。重复压缩时，上一个 `<context_compaction>` 摘要折叠为新摘要的 base，最老
   的事实得以跨多次压缩存活。PreCompact hook 可阻止压缩。

## 不变量

- 压缩前后 assistant tool_use 与 user tool_result 的配对始终合法（预算截断按整交换为单位）。
- `onCompacted(before, after)` 事件供 UI/费用面板展示；`tokens.invalidate()` 重估。

## 代码

- `src/compact.ts`（`pruneOldToolResults` / `truncateTo` / 摘要合并）、`src/agent.ts`（检查点）。
- 测试：`tests/compact.test.ts`、`tests/agent.test.ts`（microcompact 用例）。
