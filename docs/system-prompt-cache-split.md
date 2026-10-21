# 系统提示词缓存切分（stable / volatile）

## 状态

- 2026-10-21 落地（1c15e4b）。本文是系统提示词结构与 Anthropic 缓存行为的规范。

## 结构

- 系统提示词分两块：`stable`（人格、环境 cwd/平台、项目指令、记忆、技能、hook 上下文、规则、plan 规则）
  与 `volatile`（`<session_status>`：今天日期 + git status）。
- Anthropic 后端：stable 块打 `cache_control` 断点，volatile 块无缓存追加在后 —— 每轮变化的日期与
  git status 不会击穿前缀缓存。
- OpenAI 后端：`normalizeSystem` 拼接为单串（无原生缓存）。
- 纯字符串系统提示词（子代理等）经 `normalizeSystem` 兼容。

## 不变量

- volatile 只放小而高频变化的内容；记忆/技能/指令留在 stable，保证缓存命中。
- plan 模式切换会重置缓存（一次性 miss，可接受）。
- 会话内 stable 不再重建（`systemPromptCache`），planMode setter 负责失效。

## 代码

- `src/llm/types.ts`（`SystemPrompt` / `normalizeSystem`）、`src/llm/anthropic.ts`、`src/agent.ts`（buildSystemPrompt）。
- 测试：`tests/anthropicCache.test.ts`。
