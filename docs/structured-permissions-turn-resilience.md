# 结构化权限规则与回合韧性（批次 36）

状态：已实现（2026-10-23）｜来源：ZCode 对标 survey 第 4 轮 #2、#1、#10

## 背景与范围

本批次修掉一个真实的安全缺口，并补齐三类回合级可靠性：

1. **结构化权限规则 + 复合命令解析**：旧版 “always” 规则按权限描述的子串匹配。用户批准 `npm test` 后，规则可能连 `npm test; curl … | sh` 一起放行，因为描述里仍含 “npm test”。现在规则键在 `tool(pattern)` 上，bash 先拆复合命令，要求每个子命令都被覆盖。
2. **超上下文反应式压缩**：本地 token 估算低估工具/图片/协议开销时，provider 可能直接拒绝 “prompt too long”。现在识别该错误，强制压缩一次并重试同一回合。
3. **空补全重试 + 工具调用预算告警**：模型偶发返回空响应时重试一次；单回合工具调用数接近软预算时注入收敛提醒。

## 结构化规则语法

持久化格式为 `tool(pattern)`：

```
bash(npm test:*)          # bash 专用：命令前缀（空格/制表符边界，不是子串）
bash(npm test; rm -rf .)  # 精确整条命令，可用于复合/不透明命令
write_file(src/app.ts)    # 精确值（路径统一 /）
write_file(src/*.ts)      # 全值 glob：* 匹配任意字符，其余字面量
edit_file(*)              # 任意 edit_file 调用
```

- `parseStructuredRule` 只接受 `工具名(模式)`，工具名限 `[A-Za-z][A-Za-z0-9_-]*`；解析失败按旧版描述规则处理。
- `cmd:*` 前缀语法**仅对 bash** 生效；其他工具的 `*` 一律是全值 glob，不会把 `foo*` 当成前缀。
- 路径工具（`write_file` / `edit_file` / `multi_edit` / `read_file`）在比较前把 `\` 归一为 `/`，Windows 规则跨平台可用。
- 手工规则仍限制 4000 字符；自动保存的复合命令可能较长，同样受该上限约束。

## 复合命令解析

`splitShellCommand` 按 `;`、`&&`、`||`、`|`、`&` 与换行拆分，尊重单双引号与反斜杠转义，并保留 `2>&1`、`&>` 等重定向。刻意保守：

- 出现 `$()`、反引号、`(`/`)`/`{`/`}`、heredoc `<<`、未闭合引号 → 整条命令标记 `opaque`；
- 注释被跳过；纯注释命令视为不透明；
- 宁可多拆/多问，也不猜测可能隐藏命令的构造。

`bash` 工具在请求权限时传入 `PermissionRequest { tool: "bash", values: 子命令, raw: 原始命令, opaque, remember: "bash(原始命令)" }`。

## 判定顺序

```
1. 精确整条命令规则（任意层）        → allow/deny，opaque 也可被覆盖
2. deny 规则（含旧版描述规则）        → 永远拒绝
3. opaque                            → 无结论，进入人工审批
4. 单个简单子命令                    → 历史语义：结构化值规则 / 旧版描述规则，首个命中者生效
5. 复合命令                          → 每个子命令都必须被结构化 allow 覆盖；
                                       任一 deny → 拒绝；
                                       任一未覆盖 → 无结论；
                                       全部覆盖 → 自动放行
```

- 层序保持 project → global → session；上一层未命中才看下一层。
- 旧版描述 allow 规则仍能覆盖**单个简单命令**（例如 `"Run command: npm test"`），但**绝不能**覆盖复合命令的任一子命令。
- 没有结构化请求时，`tool(pattern)` 规则不会退化为描述匹配。

## 持久化与呈现

- `"session"` / `"project"` / `"always"` / `"always_deny"` 保存提示框中展示的同一条规则：优先 `request.remember`，否则 `tool(raw)`。
- 提示框新增 `allow/deny-always saves: <rule>`（Ink/GUI；CLI 为纯文本）。`PermissionAskMeta` 经 `askPermission` 第 4 参数贯穿 CLI、Ink、GUI server/state、NDJSON。
- 保存后规则立即进入对应层并参与后续判定；“always deny” 仍然压过 auto 模式，只有 yolo 全放行。

## 超上下文反应式压缩

- `isContextOverflowError(err)`：仅接受无状态或 HTTP 400/413/422，并匹配多家 provider 的措辞（`prompt is too long`、`context length exceeded`、`maximum context length`、`request too large`、`reduce the length of messages` 等）。普通 400、429、500、网络错误不触发。
- 每个回合最多一次：捕获发送错误后调用 `compactNow(events, signal, "auto")`；压缩成功且 token 估算确实下降，才 `continue` 重试同一回合，并发出 hook 事件 “provider rejected the request as too long; compacted and retrying the same turn”。
- 历史太小、压缩失败、估算未下降或被中断时，抛出原始错误。重试不消耗工具迭代预算。

## 空补全重试

判定条件：`text` 为空、`toolUses` 为空、且 input/output token 均为 0（provider 抖动而非“模型确实无话可说”）。

- 第一次：注入 `<system-reminder event="EmptyCompletion">` 要求继续，`continue` 重发；空 assistant 消息不写入历史。
- 第二次：拒绝该回合，报错 `the model returned an empty completion twice; check the provider and model settings`。
- 每回合最多重试一次，避免空响应死循环。

## 工具调用软预算

- 软预算 `TOOL_CALL_BUDGET = 100` 次/回合；硬上限仍是 `MAX_TOOL_ITERATIONS = 40` 轮（一轮可含多个并行调用，因此软预算按调用数计）。
- 在 50、75、90 次阈值各发一次 `<system-reminder event="ToolBudgetWarning">`，最多 3 条；单轮跨多个阈值时逐条补齐。
- 提醒只含建议（停止探索、避免重复调用、留出总结空间），不阻断调用。

## 测试

- `tests/permissionRules.test.ts`（14）：规则解析、前缀/精确/glob 匹配、Windows 路径归一、引号/转义/管道/重定向/替换/heredoc/注释/未闭合引号拆分。
- `tests/permissions.test.ts`（33）：旧版复合命令绕过回归、逐子命令覆盖、子命令 deny、opaque 仅精确整条规则、前缀词边界、`always` 精确保存、session/always_deny、文件工具规则。
- `tests/bash.test.ts`：bash 传入结构化权限请求（值、raw、opaque、remember）。
- `tests/llmRetry.test.ts`：多 provider 上下文溢出识别，普通错误不误判。
- `tests/agent.test.ts`：溢出后压缩并重试、普通 400 不压缩、历史过小保留原错误；空补全重试成功/二次失败；预算告警 50/75/90% 且最多 3 条、普通回合不告警。
- `tests/toolBudget.test.ts`（5）：阈值、百分比、去重、上限、跨阈值补齐。

## 刻意不做

- 不做完整的 shell 语法解析：不展开变量、glob、别名或函数；可能的隐藏命令一律标记 opaque。
- 不把 `always` 自动扩宽成前缀规则：用户看到什么规则就保存什么规则。
- 软预算不强制终止回合；硬性收敛仍由 40 轮上限与用户中断负责。
- 反应式压缩每回合只试一次，避免 provider 持续拒绝时反复付摘要成本。
- 空补全只重试一次，不叠加模型切换或降级。

## 涉及文件

`src/permissionRules.ts`（新增）、`src/permissions.ts`、`src/tools/bash.ts`、`src/tools/write.ts`、`src/tools/task.ts`、`src/types.ts`、`src/llm.ts`、`src/agent.ts`、`src/toolBudget.ts`（新增）、`src/cli.ts`、`src/headless.ts`、`src/gui/state.ts`、`src/gui/backend.ts`、`src/gui/static/{index.html,style.css,app.js}`、`src/ui/bridge.ts`、`src/ui/app.tsx`。
