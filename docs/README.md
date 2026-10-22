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
