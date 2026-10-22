# 轮次恢复与计划延续（批次 29）

状态：已实现（2026-10-23）｜来源：ZCode 对标 survey 第 3 轮 #1–#5（S 项合集）

## 背景与范围

Survey 第 3 轮对 ZCode 的 5 个候选改进，落地情况：

| # | 候选项 | 结果 |
|---|--------|------|
| 1 | max_tokens 截断后自动续写 | **已有实现**（`src/agent.ts` 的 MAX_CONTINUATIONS=3 续写路径，批次 20 引入），本次仅核对行为 |
| 2 | 压缩后读状态重注入 | **本批次新增** `src/contextRestore.ts` |
| 3 | bash 输出提示注入 + 数据 URL 图片自动附带 | **本批次新增** `src/bashHints.ts` |
| 4 | WebFetch SSRF 出网防护 | **已有实现**（`src/tools/web.ts` isBlockedAddress，对抗批次引入），本次补一个缺口：IPv6 `100::/64`（RFC 6666 discard-only） |
| 5 | 已批准计划的文件持久化与跨压缩/恢复延续 | **本批次新增** `src/planFile.ts` |

## #2 压缩后读状态重注入（contextRestore）

**问题**：compaction 重写历史后，早前 Read 过的文件内容从上下文消失；模型若不重读就编辑，会因 read-before-edit 守卫被拒，浪费轮次。

**方案**：compaction 完成后（三个重写路径：截断 fallback、摘要成功、异常 fallback 各调用一次 `restoreAfterCompaction`，每次压缩至多执行一次，`restoreRan` 标志防重）：

- 取 `FileStateStore.recent(5)`（插入序，重读会移到末尾——record 先 delete 再 set）。
- 跳过路径仍出现在保留尾部文本里的文件（原始路径与 JSON 转义形式都匹配，Windows 反斜杠在 JSON 里会翻倍；`JSON.stringify` 的结果要去掉首尾引号）。
- 文件已从磁盘消失 → 丢弃；磁盘已变更（mtime/size）→ 降级为一行警告"已变更，编辑前请重读"。
- 未变更的完整读取且 ≤16k 字符 → 直接把当前文件内容以代码块形式恢复进提醒（总预算 48k 字符，超出或部分读取降级为引用行）。
- 全部为空 → 不注入。注入体走统一 `<system-reminder event="ReadStateRestored">` 通道，tokens 缓存失效。

## #3 bash 输出后处理（bashHints）

两类增强，都作用于 bash 工具的最终输出：

**提示注入**：规则表（当前一条：GitHub API 限流报错 → 提示用 `gh api rate_limit` 查看配额），同一条提示文本 60 秒冷却防刷屏；匹配命中时在输出末尾追加 `<system-reminder event="BashHint">`。

**数据 URL 图片提取**：输出中出现 `data:image/png;base64,…` 时自动剥离为附带的图片块（ToolResult 新增 `images?: ImageBlockParam[]`，runTool 组装 tool_result 时并入 content 数组；批次 25 的媒体预算会照常对驻留历史裁剪）。约束：仅 png/jpeg/jpg/gif/webp；base64 运行段 ≥100 字符；单图 5 MiB 预算（超限替换为 `[image omitted: …]` 占位）；每结果至多 2 张；文本位置留 `[image attached from output]` 占位。实现细节：V8 正则对超长 base64 串的无界量词会栈溢出（实测 >6.99MB 必崩），改为按 1MiB 分块的手动锚定扫描。

## #4 SSRF 防护补口（web.ts）

isBlockedAddress 的 IPv6 分支新增 `100::/64`（RFC 6666 discard-only，不可路由）判定。

## #5 已批准计划的延续（planFile + agent）

**问题**：exit_plan 批准的长计划只在历史里出现一次；compaction 或 resume 之后模型只记得摘要，容易悄悄重新规划、偏离已批准方案。

**方案**：

- 批准时把计划写入 `<cwd>/.node-agent/plans/plan-<sessionId>.md`（原子写 + 先建目录；session id 中不安全字符替换为 `_`）。`ToolContext.approvePlan` 改为可返回 Promise，exit_plan 工具会 await，保证工具结果返回时文件已落盘。
- 注入：`ensurePlanAttached()` 懒加载计划文件（`undefined` = 未加载，`null` = 无计划），当计划的首个非空行（可见性标记，截 200 字符）在历史的文本块或 tool_use input JSON 中都找不到时，注入 `<system-reminder event="ApprovedPlan">`（12k 字符上限，超限截断并注明全文在磁盘）。检查 tool_use input 的 JSON 是因为单行标记会被 JSON 转义进输入参数。
- 触发点：每轮 chat 开头（resume/fork 后首轮生效一次）；每次压缩后的 `restoreAfterCompaction`。
- 生命周期：resetSession 清空已加载计划（/resume、/clear、切换会话重新懒加载）；fork 会把计划文件复制到新 session id（fork 换了 session id，旧文件不再匹配）。

## 测试

- `tests/contextRestore.test.ts`：recent 顺序（重读移末尾）、四档降级、尾部可见跳过、空读取表。
- `tests/bashHints.test.ts`：冷却期、图片提取/规范化/超限占位、提示追加。
- `tests/planFile.test.ts`：写读复制往返、id 清洗、可见性判定（文本块/tool_use input/不可见）、截断。
- `tests/agent.test.ts` 新增两组：approved-plan continuity（批准写盘且可见期不重复注入、resume 后重注入一次、压缩后重新附带、fork 带走计划）与 post-compaction read-state restore（恢复文件内容、无读取不注入）。旧的 plan-mode 测试改用临时 cwd（exit_plan 批准现在会写盘，不能污染仓库目录）。

排障记录：compactNow 依赖 TokenCounter 锚点——真实 LLM 回报的 input tokens 一旦设锚，char 估算被旁路，脚本回合必须上报 0 用量才能让测试里的 compaction 真正发生。

## 验证

vitest 全量 75 文件 / 964 通过；`npm run lint`（tsc --noEmit + node --check）；`npm run build` 通过。
