# 会话用量基线 + web_fetch 缓存 + Windows 破坏性命令 + tool_search 持久化（批次 38）

状态：已实现（2026-10-23）｜来源：ZCode 对标 survey 第 6 轮（A+B+C+D 全包）

## 背景与范围

本批次四件事，全部来自 ZCode 源码对标发现的 mojo 缺口：

1. **A：会话真实用量基线** —— 恢复会话后 autocompact 与 /context 继续用字符估算而非真实用量；
2. **B：web_fetch TTL+LRU 缓存** —— 同一 URL 反复抓取每次都走网络；
3. **C：Windows 破坏性命令分类加固** —— cmd 的 `rd /S` 树删除与 `robocopy /MIR` 不在危险清单里；
4. **D：tool_search 已发现工具持久化** —— CLI 重启后已暴露的 deferred 工具全部丢失，必须重新搜索。

## A：会话真实用量基线

### 设计

- `TokenCounter.snapshot()`（src/tokens.ts）返回当前锚点 `{ count, tokens }`（无锚点时为 null）；`restoreAnchor(count, tokens)` 重新挂载上一个进程留下的锚点（非法输入静默忽略）。
- `SessionMeta.usage: { messages, tokens }`（src/session.ts）：语义为"前 `messages` 条消息恰好花费 `tokens`"。`saveUsage()` 写入（非法值丢弃），加载侧白名单重建时同步解析清洗。
- `agent.persistTurn()` 在回合末尾 diff 快照，变化才调用 `saveUsage()`；`loadGoal()` 更名 `loadSessionMeta()`，在 `/resume` / `resetSession` 时恢复锚点，守卫条件 `usage.messages <= this.messages.length` —— 压缩/裁剪后的历史比保存时短，计数校验自然拒绝过期锚点，回落到字符估算。
- forkSession 刻意不复制 usage（新会话的历史前缀已经改变）。

### 效果

恢复会话后 `tokenEstimate()` 直接返回真实锚点值（消息数吻合时），autocompact 决策与 /context 的"anchored"行不再从零估算。

## B：web_fetch TTL+LRU 缓存（src/tools/web.ts）

- 模块级 Map，键为请求 URL，值为 `{ status, body, contentType, finalUrl, expiresAt, bytes }`；
- TTL 默认 15 分钟（`AGENT_WEBFETCH_CACHE_TTL_MS` 可覆盖）；总量预算 8 MB（单条受 MAX_BODY_BYTES=1MB 限制）；put 时先清过期再按 LRU 逐出直到预算内；get 时 delete+set 刷新 LRU 顺序；
- `AGENT_WEBFETCH_CACHE=0` 整体关闭；只缓存 <400 的成功响应，错误永远重取；web_search 从不缓存；
- 缓存命中在 `Source:` 行标注 `(cached)`；导出 `clearWebFetchCacheForTests()`；web_fetch 工具描述同步说明。

## C：Windows 破坏性命令分类加固（src/tools/bash.ts）

新增 `isWindowsDestructiveDelete()` 并入 `isDangerousCommand()`（移植 ZCode guarded/windows-delete.ts 语义）：

- cmd `rd`/`rmdir` 带 `/S`（组合开关如 `/s /q` 也识别）→ 树删除；无 `/S` 只删空目录不算；纯 `/?` 帮助调用不算；
- `robocopy` `/MIR` 或 `/PURGE` 且源+目标 ≥2 个路径且无 `/L`（list-only）→ 镜像删除；`/XF /XD` 排除列表中的词不计入路径数；
- 连带效果：只读分类硬拒（Explore 子代理）、主 bash 标注危险并以 high 等级请求审批。

`del`/`erase`/`Remove-Item` 等既有模式本就覆盖，未改动。

## D：tool_search 已发现工具持久化

- `SessionMeta.exposedTools?: string[]` + `saveExposedTools()`（去重、截断 80 字符、上限 100 个、空列表清除），加载侧同样解析清洗；
- `tools/index.ts` 新增 `exposedToolNames()` 导出当前暴露集合；
- `persistTurn()` diff 后持久化；`loadSessionMeta()` 恢复时逐个 `exposeTool(name)`（未知/非 deferred 名称静默跳过，比如服务器已断开），并同步 diff 基线。

## 测试

- tokens.test.ts：snapshot/restore 单元 + 过期锚点被 count() 拒绝；
- session.test.ts：usage/exposedTools 写读、非法值丢弃、去重与清除；
- web.test.ts：命中标注、错误不缓存、`AGENT_WEBFETCH_CACHE=0`、TTL 过期、8MB 预算 LRU 逐出；
- bash.test.ts：`rd /S`、`robocopy /MIR|/PURGE`、`/L` 豁免、`/XF /XD` 列表、只读类排除；
- agent.test.ts：回合末持久化锚点、/resume 恢复锚点（过期拒绝）、tool_search 暴露持久化与恢复。

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `AGENT_WEBFETCH_CACHE` | 开启 | `0` 关闭 web_fetch 缓存 |
| `AGENT_WEBFETCH_CACHE_TTL_MS` | 900000 | 缓存条目 TTL（毫秒） |
