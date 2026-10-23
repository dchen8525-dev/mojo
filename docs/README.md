# docs/ — 功能规格索引

本目录是 mojo 各功能的事实规范（spec），借鉴 ZCode 的 docs discipline：**每个功能一篇简短、
带日期与 commit 的 spec**。今后新功能合入 main 时应随附对应 spec；行为变化时先改 spec 再改代码。

## 索引（2026-10-21/22 ZCode 借鉴弧线）

| Spec | Commit | 主题 |
| --- | --- | --- |
| [retry-backoff-stream-idle.md](retry-backoff-stream-idle.md) | dcc8385 | 指数退避重试 + 流空闲看门狗 |
| [permission-scopes.md](permission-scopes.md) | 594bbfe | 权限答案的作用域（session/project/always） |
| [mid-turn-steering.md](mid-turn-steering.md) | 327ea78 | 回合中段用户转向输入 |
| [compaction-microcompact.md](compaction-microcompact.md) | f21165b | 全量压缩与 prune-only 微压缩 |
| [bash-policy.md](bash-policy.md) | a3ca3e4, 3395af1 | bash 只读分类、分级超时、子代理只读 shell |
| [skills.md](skills.md) | c4ff6b2 | SKILL.md 技能系统与渐进披露 |
| [workspace-hook-trust.md](workspace-hook-trust.md) | 60da2c7 | 项目 hooks 的按工作区信任 |
| [read-before-edit-guard.md](read-before-edit-guard.md) | 62f4caf | 写前必须先读的新鲜度守卫 |
| [system-prompt-cache-split.md](system-prompt-cache-split.md) | 1c15e4b | 系统提示词的缓存稳定/易变切分 |
| [tool-result-artifacts.md](tool-result-artifacts.md) | 8a4509e | 超大工具结果落盘为可读 artifact |
| [tool-wave-scheduler.md](tool-wave-scheduler.md) | 3395af1 | 工具调用的波次并发调度 |
| [system-reminder-channel.md](system-reminder-channel.md) | 3395af1 | 元通知统一 `<system-reminder>` 通道 |
| [tool-search-deferred-catalog.md](tool-search-deferred-catalog.md) | 9b72828 | tool_search 延迟工具目录 |
| [background-subagents.md](background-subagents.md) | 2026-10-21 | 后台子代理（分离运行 + 完成提醒） |
| [bash-background-completions.md](bash-background-completions.md) | b42fc3f | bash 后台任务完成通知 |
| [undo-conflict-detection.md](undo-conflict-detection.md) | b42fc3f | /undo 冲突检测与 --force |
| [prompt-assembly.md](prompt-assembly.md) | 2026-10-22 | 提示词装配：turn completion / 工具门控 / 仓库快照 |
| [tool-input-validation.md](tool-input-validation.md) | 2026-10-22 | 工具输入校验错误格式化 |
| [repetition-reminders.md](repetition-reminders.md) | 2026-10-22 | 重复调用异常提醒 |
| [atomic-writes.md](atomic-writes.md) | 2026-10-22 | 原子写入（write/edit/session） |
| [bash-read-state.md](bash-read-state.md) | 2026-10-22 | bash 读态回填与 formatter 失效 |
| [remote-mcp-servers.md](remote-mcp-servers.md) | 2026-10-22 | 远程 MCP 服务器（Streamable HTTP / SSE） |
| [mcp-oauth.md](mcp-oauth.md) | 2026-10-22 | MCP OAuth 2.1 授权（PKCE + 本机回环回调） |
| [cron-automation.md](cron-automation.md) | 2026-10-22 | 定时任务：cron 表达式、单所有者调度、无头执行 |
| [memory-recall.md](memory-recall.md) | 2026-10-22 | 记忆召回选择器：裁剪旧条目按需注入 |
| [gui-transport-hardening.md](gui-transport-hardening.md) | 2026-10-22 | GUI 请求体上限、令牌作用域、SSE 背压、会话文件权限 |
| [adversarial-analysis-2026-10-22.md](adversarial-analysis-2026-10-22.md) | 7ff28f1 | 十轮对抗性审计报告（cron → OAuth） |
| [scroll-ownership-approval-diff.md](scroll-ownership-approval-diff.md) | 857575a | GUI 流式滚动所有权 + 审批弹窗结构化 diff |
| [gui-notifications-conversation-find.md](gui-notifications-conversation-find.md) | 2026-10-22 | 失焦任务通知 + Ctrl+F 会话内查找 |
| [headless-ndjson.md](headless-ndjson.md) | 2026-10-22 | 打印模式 NDJSON 事件契约（--output-format stream-json） |
| [journal-doctor.md](journal-doctor.md) | 2026-10-22 | 模型 I/O 日志（AGENT_JOURNAL）+ /doctor 体检 |
| [command-center.md](command-center.md) | 2026-10-22 | GUI 命令中心（Ctrl/Cmd+P 面板） |
| [edit-match-strategies.md](edit-match-strategies.md) | 2026-10-22 | edit_file 多策略模糊匹配与歧义检测 |
| [autocompact-decision.md](autocompact-decision.md) | 2026-10-22 | autocompact 输出预留与失败熔断 |
| [sse-replay-fixtures.md](sse-replay-fixtures.md) | 2026-10-22 | SSE 回放夹具：事件契约漂移检测 + happy-dom 回放 |
| [subagent-persistent-memory.md](subagent-persistent-memory.md) | 2026-10-22 | 命名子代理持久记忆（save_memory 工具 + 系统提示注入） |
| [shell-snapshot-and-cancelled-stream.md](shell-snapshot-and-cancelled-stream.md) | 2026-10-22 | 取消流部分文本持久化 + Windows PowerShell profile 环境快照 |
| [subagent-mailbox.md](subagent-mailbox.md) | 2026-10-22 | 子代理会话邮箱（send_message / message_parent 双向轮边界消息） |
| [runtime-command-queue.md](runtime-command-queue.md) | 2026-10-22 | 统一运行时命令队列（忙碌输入排队为后续回合 + 插话开关） |
| [media-budget.md](media-budget.md) | 2026-10-22 | 媒体预算：入站图片校验 + 驻留历史最旧优先裁剪 |
| [workspace-rewind.md](workspace-rewind.md) | 2026-10-22 | 工作区回滚：检查点重放 + /rewind 预览/应用/强制 |
| [session-fork-branches.md](session-fork-branches.md) | 2026-10-22 | 会话 fork 分支：血缘元数据 + 模型通知 + /sessions 呈现 |
| [memory-write.md](memory-write.md) | 2026-10-22 | 记忆写入侧：save_memory 工具 + opt-in 自动提取 + /dream 整理 |
| [turn-restore-plan-continuity.md](turn-restore-plan-continuity.md) | 2026-10-23 | 压缩后读状态重注入 + bash 提示/图片提取 + 已批准计划延续 + SSRF 补口 |
| [session-titles-subagent-mirroring.md](session-titles-subagent-mirroring.md) | 2026-10-23 | 会话标题 sidecar（首轮自动命名）+ 子代理工具事件实时镜像（start/result） |
| [context-breakdown-early-tools.md](context-breakdown-early-tools.md) | 2026-10-23 | /context 上下文用量分解 + 只读工具流式提前执行（onToolReady） |
| [structured-questions-session-context.md](structured-questions-session-context.md) | 2026-10-23 | 结构化提问 ask_user（1–4 问/超时放行）+ 跨会话检索 read_session（#sess_ 引用/词法选段/预算） |
| [stream-recovery-state-machine.md](stream-recovery-state-machine.md) | 2026-10-23 | 流恢复状态机：文本续写 resume / 工具调用中断 restart + 预算退避 + 四端回滚 |
| [persistent-node-repl.md](persistent-node-repl.md) | 2026-10-23 | 常驻 Node REPL：每会话独立进程 + 跨调用绑定 + 超时/中断重启 + 高风险审批 |
| [session-goal-autopilot.md](session-goal-autopilot.md) | 2026-10-23 | 会话目标自动续跑：LLM 完成校验 + nextAction + 预算/续跑上限 + /goal + 三端事件 |
| [structured-permissions-turn-resilience.md](structured-permissions-turn-resilience.md) | 2026-10-23 | 结构化权限规则 + 复合命令解析；超上下文反应式压缩；空补全重试 + 工具调用软预算告警 |
| [apply-patch-aux-downgrade-communication.md](apply-patch-aux-downgrade-communication.md) | 2026-10-23 | apply_patch 多文件补丁工具；辅助 LLM 调用降档（5k 上限/关思考）；沟通规范提示词；nodeRepl 在途请求空闲竞态修复 |
| [session-usage-webcache-windows-delete.md](session-usage-webcache-windows-delete.md) | 2026-10-23 | 会话真实用量基线（resume 后精确压缩决策）；web_fetch TTL+LRU 缓存；Windows 树删除/robocopy 镜像破坏性分类；tool_search 已发现工具持久化 |
