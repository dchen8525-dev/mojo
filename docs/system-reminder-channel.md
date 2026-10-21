# 元通知统一通道（system-reminder）

## 状态

- 2026-10-21 落地（3395af1）。本文是基础设施向对话注入元通知的格式规范。

## 格式

- `systemReminder(body, attrs)` 生成 `<system-reminder k="v">…</system-reminder>`；属性值转义引号。
- 基础设施注入的元通知（hook 上下文）一律走此通道；模型与用户的真实内容保持纯文本。

## 当前注入点

| 事件 | 位置 | 属性 |
| --- | --- | --- |
| SessionStart | 系统提示词 | `event="SessionStart"` |
| UserPromptSubmit | 追加到用户 prompt 尾部 | `event="UserPromptSubmit"` |
| PostToolUse | 追加到 tool_result 尾部 | `event="PostToolUse"` |

## 不变量

- `<context_compaction>` 压缩标记不迁移：它是被 `compact.ts` 解析回读的持久协议，不是通知。
- 转向（steering）消息不包装：它是真实用户输入，不是元通知。
- 新增通知源（如将来的后台任务完成提醒）应复用本通道，而不是发明新标签。

## 代码

- `src/reminder.ts`；接入点 `src/agent.ts`。
- 测试：`tests/reminder.test.ts`。
