# 模型 I/O 日志与 /doctor

## 状态

- 2026-10-22 落地。调试辅助：opt-in 的 LLM 请求/响应日志 + 一条体检命令。

## 模型 I/O 日志（AGENT_JOURNAL=1）

- 默认关闭。`AGENT_JOURNAL=1`（或 `true`）开启后，每次 LLM 请求（含重试/续流的逻辑请求，
  一次一条）追加为一行 JSON 到 `~/.node-agent/journal/<session>.jsonl`（目录 0700、文件 0600）。
- 条目字段：`ts`、`sessionId`、`provider`、`model`、`durationMs`、`request`
  （`messageCount` / `systemChars` / `toolNames` / `messages` 全量提示词）、`response`
  （`text`、`toolUses`（name+input）、`stopReason`、`input/outputTokens`、缓存读写 tokens）
  或 `error`。
- 安全与容量：
  - API key 永远不出现在任何条目里。
  - 单条超过 16 MB 时丢弃 `messages`（置 `messagesOmitted: true`），其余照记。
  - 目录预算 64 MB / 200 个文件，每 25 次追加裁剪一次（留一个间隔的余量，先删最旧）。
  - 写入经模块级串行链，绝不 reject——日志故障不能影响回合本身。
- 用途：排查提示词装配、工具循环异常、续流去重等问题。提示词包含工具结果全文，
  属于敏感数据，所以是显式 opt-in 而非默认开启。

## /doctor

- 共享命令运行器实现，CLI（Ink）与 GUI 通用。输出清单（✓/⚠/✗ 前缀，无 ANSI）：
  - api key：是否设置（只显示 `sk-…后4位` 掩码 + 来源：环境 / 全局 / 项目配置）
  - model：当前 provider:model、上下文窗口、endpoint
  - context：已用 / 窗口 tokens（超过压缩阈值标 ⚠）
  - session：id 与消息数
  - permissions：模式 + 全局/项目/会话规则数
  - mcp：连接 n/m、工具总数、失败服务器逐条原因；`--no-mcp` 时标 ⚠
  - hooks：加载数；项目 hooks 未信任时标 ⚠ 并提示 /hooks trust
  - cron：owner / standby / 未运行
  - lsp：服务器数与文档数，报错的服务器逐条列出
  - journal：off（提示如何开启）或 on + 文件数与目录体积

## 实现与测试

- `src/journal.ts`：`recordJournalTurn()` / `journalStats()` / `journalEnabled()`。
- `src/llm.ts`：`send()` 变为记录包装器，原续流循环改名 `sendResumable`；
  `llm.journalSession` 由 Agent 构造时赋值。
- `src/cronScheduler.ts`：新增 `get isStarted()`。
- `src/agentCommands.ts`：`/doctor` case + BUILTIN_COMMANDS + /help 行。
- 测试：`tests/journal.test.ts`（开关、禁用不落盘、逐行 JSON、敌意 id 消毒、超大条目
  丢 messages、202 文件裁剪到预算内）；`tests/agentCommands.test.ts` 的 /doctor 三例
  （全部子系统都报告且不泄漏 key、降级子系统出 ⚠、模型覆盖生效）。
