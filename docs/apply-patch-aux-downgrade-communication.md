# apply_patch 多文件补丁 + 辅助调用降档 + 沟通规范（批次 37）

状态：已实现（2026-10-23）｜来源：ZCode 对标 survey 第 5 轮（A+B+C 组合包）

## 背景与范围

本批次三件事，全部来自 ZCode 源码对标：

1. **A：apply_patch 多文件补丁工具** —— 移植 ZCode 的 `*** Begin Patch` 解析器与应用器，一次调用完成多个文件的 Add / Delete / Update / Move；
2. **B：辅助 LLM 调用降档** —— 标题生成、goal 校验、记忆提取、dream、压缩摘要等辅助调用统一 5k 输出上限 + 关闭思考，`AGENT_AUX_MAX_OUTPUT` 可覆盖；
3. **C：沟通规范提示词** —— 在稳定系统提示中加入最终消息纪律段落。

## A：apply_patch

### 补丁格式（src/patch.ts）

```
*** Begin Patch
*** Add File: new.ts
+export const a = 1;
*** Delete File: old.ts
*** Update File: mid.ts
*** Move to: renamed.ts
@@ <可选上下文锚（整行）>
 被保留的上下文行
-被删除的行
+被添加的行
*** End of File   ← 可选：把 hunk 锚定到文件末尾
*** End Patch
```

- 解析器支持 heredoc 包裹剥离（`cat <<'EOF' … EOF`）、CRLF 归一、`*** End Patch` 之后的内容忽略。
- 第一个 End 标记闭合补丁；段头缺失路径、Add 段裸行、非法 hunk 行均报解析错误。

### hunk 匹配（四级递进）

上下文匹配按 `精确 → trimEnd → trim → unicode 归一`（弯引号/破折号/省略号/nbsp）递进。`@@` 锚是**整行**查找，命中后从锚之后开始匹配 oldLines；空 oldLines 表示纯插入——带锚点时插在锚点行之后，只有无锚点时才追加到文件尾；尾随空行模式先裁剪再重试；`End of File` 只允许锚到末尾。匹配失败抛 `Failed to find expected lines`，工具把它包成 "Re-read the file and copy the exact lines into the hunk."

### 工具行为（src/tools/patch.ts）

- **先全量规划，后落盘**：所有段先解析+校验（存在性、读状态守卫、hunk 可应用、重复段 `类型:路径` 去重），任何一段失败则整个补丁不碰磁盘。
- **移动安全**：目标路径与源相同直接拒绝（实现是先写目标再删源，同路径会删掉刚写入的内容）；目标已存在也拒绝，不静默覆盖。
- **跨段冲突检测**：两个段触碰同一路径（update+delete、move 源/目标交叉等）时整包拒绝，避免后写入覆盖前一段的结果。
- **读状态守卫**：update/delete 目标必须先被本会话读过（复用 `FileStateStore.check`），未读/过期/部分读分别给出 `editGuardMessage` 文案。
- **权限**：每个受影响路径一次结构化请求 `{ tool: "apply_patch", values: [显示路径] }`，risk `high`，预览带 `@@` 头（move 用目标路径、上限 120 行裁剪）。既有 allow 规则静默放行（move 规则键在目标路径上）；任一路径被拒则整个补丁中止。
- **执行**：delete → checkpoint → unlink → finalize → invalidate；add/update → checkpoint →（add 建目录）→ `atomicWriteFile` → finalize → `recordCurrent`；move → 带 `movedTo` 的 checkpoint → `atomicWriteFile` 目标 → unlink 源并失效读状态 → finalize → `recordCurrent`。move 的 finalize 必须在 unlink 之后，否则 checkpoint 记录的是移动前的源内容，`/undo` 会把它当成用户改动而拒绝；`movedTo` 让 `/undo`/`/rewind` 同时删除目标副本。内容 <400k 时追加 `diagnosticsHint`。
- **结果**：`Patch applied.` + 每路径一行 `A/M/D 路径 (+N/-M)`，move 显示 `M old -> new`。
- 工具列表注册在 `multi_edit` 之后；`toolGuidance` 新增 apply_patch 块（多文件改动一次调用、逐字拷贝行、失败时加宽上下文，不得用 shell 替代），仅在工具在场时注入。

## B：辅助调用降档

- `SendOptions { maxOutput?, thinking? }` 贯穿：`LLM.send`（第 6 参）→ `sendResumable` → 两个后端 `backend.send`（第 7 参）。
  - anthropic：`max_tokens: opts?.maxOutput ?? 模型默认`；thinking 仅在 `opts?.thinking !== false` 且 env 允许时启用。
  - openai：推理模型写 `max_completion_tokens`，否则 `max_tokens`，`opts?.maxOutput` 优先。
- `auxiliarySendOptions()`（src/auxiliary.ts）：`maxOutput = AGENT_AUX_MAX_OUTPUT（>0 时生效） ?? 5000`，`thinking: false`。
- 应用点（5 处）：压缩摘要 agent.ts、goal 校验、记忆提取、会话标题 sessionTitle.ts、dream memoryWrite.ts（`LlmLite` 接口同步加 `opts` 参）。
- 刻意全预算不动：/review、主回合 send、子代理 task。

## C：沟通规范

稳定系统提示结构变为 `TURN_COMPLETION + COMMUNICATION + toolGuidance(...)`。COMMUNICATION 段（6 条）：首个工具调用前一句话说明意图、工作中发现关键信息时简短更新；答案/结论必须落在最终文本消息里（工具调用后不再有文字）；先给结果再给细节；可读性优先于极简（完整句子、写全术语）；简单问题直接答不堆标题；代码风格贴近上下文、注释只写代码本身表达不了的约束。

## 测试

- `tests/patch.test.ts`：解析（add/delete/update/move/EOF、heredoc、错误路径）+ 应用（上下文 hunk、追加、带锚点插入、EOF 锚、trimEnd、unicode 归一、锚行、尾空行裁剪、失败报错）。
- `tests/patchTool.test.ts`：单调用四操作、逐路径结构化权限请求与预览、拒绝即全停、读守卫拦截 update/delete、hunk 失配不动盘、add 已存在、重复段/空补丁/无标记、移动到自身/目标已存在/跨段冲突被拒、写入后读状态已记录、move 后 `/undo` 恢复源并删除目标副本。
- `tests/auxiliary.test.ts`：默认 5000/thinking:false、env 覆盖、非法值忽略。
- `tests/prompts.test.ts`：COMMUNICATION 内容、apply_patch 块随工具出现/缺席。
- `tests/agent.test.ts`：压缩摘要调用断言 `sentOpts[0] = { maxOutput: 5000, thinking: false }`。
- 顺带修复 nodeRepl 既有竞态：内核 spawn 后首个请求若超过空闲阈值，空闲停机会杀掉在途请求；现在请求在途期间不挂空闲计时器（`touch()` 跳过 + runOnce 设 pending 后清计时器），nodeRepl 空闲测试不再需要运气。

## 验证

`npx vitest run` 86 文件 1185 通过 7 跳过；`npm run lint`、`npm run build` 干净。
