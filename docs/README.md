# docs/ — 功能规格索引

本目录是 mojo 各功能的事实规范（spec），借鉴 ZCode 的 docs discipline：**每个功能一篇简短、
带日期与 commit 的 spec**。今后新功能合入 main 时应随附对应 spec；行为变化时先改 spec 再改代码。

## 索引（2026-10-21 ZCode 借鉴弧线）

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
