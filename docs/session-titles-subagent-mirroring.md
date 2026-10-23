# 会话标题 sidecar 与子代理工具事件镜像（批次 30）

状态：已实现（2026-10-23）｜来源：ZCode 对标 survey 第 3 轮 #8 + #10（S 项合集）

## 背景与范围

Survey 第 3 轮剩下的两个 S 项：

| # | 候选项 | 结果 |
|---|--------|------|
| 8 | 会话自动命名 sidecar（首轮请求 → 短标题，侧栏展示） | **本批次新增** `src/sessionTitle.ts` |
| 10 | 子代理工具事件实时镜像（开始/结果回传父流） | **本批次增强**：新增“开始”阶段，贯通 CLI/GUI/NDJSON |

## #8 会话标题 sidecar

**问题**：侧栏和 `/sessions` 只能显示会话 id 或首条消息预览，存了几十个会话后很难辨认。

**方案**（`src/sessionTitle.ts` + `src/agent.ts`）：

- 时机：每个会话**第一条真实用户消息所在回合结束后**（`persistTurn()` 之后）后台执行；不阻塞回复，也不会把标题调用混进主对话流。`isRealUserTurn` 跳过 `<system-reminder>` / `<context_compaction>` 这类注入内容；resume 回来的会话已有真实用户轮次，不再命名。
- 输入：首条请求折叠空白、截 1200 字符；少于 10 字符（“hi”、“修一下”）直接跳过——短请求本身比模型起的名字更准。
- 调用：复用当前 LLM 实例，60 秒超时；系统提示要求“3–7 个词、与用户同语言、只输出 `{"title":"..."}`”。计费记入当前会话成本（provider:model）。
- 清洗：先剥 `<think>`；优先解析 JSON（含 ```json 围栏与前后废话），否则取首个非空行；去掉 Markdown 标题前缀、首尾引号、尾部标点；纯符号结果拒绝；超长截到 80 字符（与 session store 既有标题上限一致）并以 `…` 结尾。
- 存储（`src/session.ts`）：新增 `titleSource: "generated" | "custom"`。`setGeneratedTitle` 在 `updateMeta` 的读-改-写锁内做 CAS：**已有标题（无论用户改名还是早前生成）一律不覆盖**。用户 `/rename` 或侧栏改名写 `custom`；清空标题会同时删除 `titleSource`，之后仍可被自动命名。
- 失效与退出：标题是装饰，任何异常（网络、超时、解析失败）静默吞掉，绝不影响回合。`AGENT_SESSION_TITLES=0` 全局关闭；打印模式（cron / `-p`）在 `runPrint` 里 `disableSessionTitles()`，不额外花一次调用；vitest 默认关闭，专用测试用 `enableSessionTitlesForTests()` 打开。
- 可见性：`/sessions` 与 GUI 侧栏本就读 `SessionMeta.title`；新增 `onSessionTitle` 事件 → GUI 广播 `session_title` → 侧栏即时刷新。没有标题时侧栏回退 `meta.preview`——由 `parseSessionFile` 在加载时推导（首个真实用户请求、折叠空白、截 60 字符），此前 `preview` 字段存在但从未填充。
- 刻意不做（相对 ZCode 的简化）：fork 不自动生成 “Fork of X” 标题（fork 仍可带 `title` 选项）；不提供标题模型单独配置；不保留“标题工单”状态。

## #10 子代理工具事件镜像

**问题**：此前 `task` 子代理的工具调用只在**完成后**通过 `onSubTool` 上报一次，长调用（grep 大仓库、web_fetch）在 GUI 的调用链里看不到“正在跑什么”。

**方案**：

- 新事件：`ToolContext.onSubToolStart(name, inputPreview, round)` / `AgentEvents.onSubToolStart(parentId, ...)`；`src/tools/task.ts` 在 `tool.execute` **之前**发出（未知工具分支不发，因为它从未真正运行）。
- 完成事件 `onSubTool` 语义不变，仍是唯一会被持久化的阶段（session `subcall` 行、GUI 调用链重建都依赖它）。
- GUI（`src/gui/server.ts`）：`sub_tool_start` 只做实时广播并在 live turn 的调用链里插入 `running: true` 行；`sub_tool` 到达时按 `name + round + inputPreview` 回填最近的 running 行（窗口重连、错过 start 时退化为追加）。`UiSubCall.running` 是纯 UI 字段，不写盘。前端 `app.js` 对应显示“运行中…”脉冲状态；`session_title` 事件触发侧栏重载。
- NDJSON（`src/headless.ts`）：新增 `{"type":"sub_tool_start","parent_id","name","input_preview","round"?}`，与既有 `sub_tool` 一起构成完整生命周期；`session_title` 也会作为一行事件输出（仅自动命名成功时出现一次）。
- 不镜子代理的权限弹窗/思考增量（ZCode 也不镜像权限事件；思考属于子代理私有上下文）。

## 测试

- `tests/sessionTitle.test.ts`（新）：JSON/围栏/纯文本/think/引号/标题前缀清洗、纯符号与 JSON 无标题拒绝、80 字符省略、输入下限与 1200 字符截断、`generateSessionTitle` 的用量与无标题返回、开关（vitest 默认关、env 关闭、显式启用）。
- `tests/session.test.ts`：`setGeneratedTitle` 只写一次且不覆盖；用户改名 `custom` 优先、清空后可再生成；不存在会话返回 false；`preview` 跳过注入上下文并截 60 字符（同时修复了手改文件里非法 content block 会让 preview 推导抛错、进而拖垮 `listSessions` 的隐患）。
- `tests/agent.test.ts`：首轮生成标题并触发 `onSessionTitle`、既有标题不重新生成、resume/短消息不尝试。
- `tests/taskBackground.test.ts`：子代理工具 start→end 顺序、失败工具同样有 start、未知工具不发 start。

## 配置速查

| 变量 / API | 作用 |
| --- | --- |
| `AGENT_SESSION_TITLES=0` | 关闭自动会话命名 |
| `Agent.waitForSessionTitle()` | 测试用：等待后台命名结束 |
| SSE `sub_tool_start` / `sub_tool` | GUI 调用链实时开始/完成事件 |
| NDJSON `sub_tool_start` / `sub_tool` / `session_title` | 打印模式事件契约扩展 |
