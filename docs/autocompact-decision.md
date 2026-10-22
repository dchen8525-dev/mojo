# autocompact 决策层:输出预留 + 熔断

状态:已合入 main(2026-10-22)。借鉴 ZCode `packages/core/src/compact/policy.ts`(preflight 预留与 `maxConsecutiveAutocompactFailures`)。

## 动机

旧触发条件是 `tokenEstimate() > window × 0.75`。两个缺口:

1. 没有为**下一响应的输出**预留空间——足迹刚好低于阈值时,一次长输出仍可能把请求顶过 provider 硬限;
2. 压缩失败(如尾部存在无法丢弃的巨型交换)后,每个回合都会重试摘要器调用——**死循环烧钱**。

## 行为

- **输出预留**:决策改为 `tokenEstimate() + reserve > window × 0.75`。`reserve = min(model maxOutput, 16_384)`(模型表来自 `lookupModel`;推理模型的超大 maxOutput 被封顶,避免在半窗口就触发压缩)。`AGENT_OUTPUT_RESERVE` 环境变量可覆盖。
- **熔断**:一次自动压缩后投影仍超预算记失败一次;连续 **3 次**(`MAX_AUTOCOMPACT_FAILURES`)后暂停自动压缩,经 `<system-reminder>` 通道(onHook "compact")提示改用 /compact;已暂停期间每回合仅提醒一次。
- **重置**:手动 `compactNow`(/compact)成功调用即重置;`resetSession`(/resume、/clear、/fork、切换会话)重置;投影回落到预算内时清零失败计数。
- 微压缩(0.70 prune-only)保持原触发条件,不引入预留。

## 涉及文件

- [src/agent.ts](../src/agent.ts):`outputReserve()`、`autoCompactFails/autoCompactSuspended`、chat 循环决策块、`compactNow`/`resetSession` 重置;导出 `MAX_AUTOCOMPACT_FAILURES`。
- 逐回合分组(groupByAssistantStartedRounds)未移植:mojo 的 `pickCompactBoundary` 已在 plain-user 边界切分,等价满足"摘要尊重回合边界"。

## 测试

[tests/agent.test.ts](../tests/agent.test.ts) 新增 4 例:

- 预留使压缩在 66.8k~75k 区间提前触发(70.1k 历史被压缩,13 对 65.1k 不触发);
- 巨型单消息(不可剪枝、不可丢弃)跨回合累积失败,第 3 次失败熔断、第 4 回合提示;
- `compactNow` 重置熔断后允许重新尝试。

全量:66 文件 / 846 通过 / 5 跳过(lint + build 干净)。
