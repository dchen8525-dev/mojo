# 工具输入校验错误格式化

## 状态

- 2026-10-22 落地（本批）。

## 行为

`validateToolInput(schema, input)` 在工具执行前校验模型给出的 JSON 输入，返回 `null`
或一条模型可直接照做的错误。规则：

- **根类型**：输入必须是 JSON object；否则报 `Tool input must be a JSON object, got <type>`。
- **必填缺失**：报 `Missing required parameter "<k>"`，并列出 `Available parameters: ...`。
  若输入里出现未知参数，追加 `Unknown parameter(s): "<k>" (did you mean "<c>"?)`——
  建议基于编辑距离（阈值 ≤3，键长 ≥3）。
- **类型不符**：报 `Parameter "<k>" must be <type>, got <type> (<value preview>)`，
  值预览为截断的 JSON（≤80 字符）。
- **枚举**：schema 声明 `enum` 时，报 `must be one of: ...; got ...`。
- **数组元素**：声明 `items.type` 时检查每个元素，报第一个越界元素的索引与类型。

未知参数在**必填项齐全**时仍被忽略（保持对 MCP `additionalProperties` 工具的兼容）；
它们只在缺失必填项时作为诊断线索出现。

## 代码

- `src/types.ts`；`Agent.runTool` 将错误包装为 `Invalid input for "<tool>": ...`。
- 测试：`tests/hygiene.test.ts`。
