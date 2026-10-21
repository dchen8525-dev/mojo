# 重试退避与流空闲看门狗

## 状态

- 2026-10-21 落地（dcc8385）。本文是 LLM 请求重试与流空闲行为的规范。

## 重试策略

- 瞬时错误（429/5xx/超时/连接错误）自动重试：退避 `base * 2^n`，上限 60s，±25% 抖动。
- env 可调：`AGENT_RETRY_BASE_MS`、`AGENT_RETRY_MAX_ATTEMPTS`、`AGENT_RETRY_MAX_DELAY_MS`、`AGENT_RETRY_JITTER`。
- 非瞬时错误（401/403/400）不重试，直接上抛。

## 流空闲看门狗

- 流建立后若 `AGENT_STREAM_IDLE_MS`（默认 60s）内无任何 chunk，判定为空闲并终止本轮。
- 每次重试将看门狗放宽 +30s，避免长首 token 场景反复误杀。
- 终止时抛 `StreamIdleError`，进入正常重试通道；CLI/GUI 显示重试状态。

## 代码

- `src/llm/idle.ts`（看门狗包装，两个后端共用）、`src/llm/anthropic.ts`、`src/llm/openai.ts`。
- 测试：`tests/llmIdle.test.ts`、`tests/llmRetry.test.ts`。
