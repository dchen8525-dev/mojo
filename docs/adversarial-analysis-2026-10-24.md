# 对抗分析 10 轮（2026-10-24）

## 状态

- 2026-10-24 完成。本文记录对本批 2026-10-23/24 新增功能的 10 轮对抗性审查：前 9 轮每轮选
  一个攻击面，按「复现真实缺陷 → 最小修复 → 回归测试」推进；第 10 轮做收尾复核、全量回归与
  文档。收尾后又追加十二处修复：cron 租约的未来 mtime 误判（全量回归时暴露的间歇失败）、只读
  提前执行的可重放性（复核未覆盖的批次 31）、压缩后读状态恢复的尾部判定（批次 29 回归）、
  Windows 树删除分类的包装绕过（批次 38 回归）、大截图的流式输出上限（批次 29 回归）、
  tool_search 暴露的跨会话泄漏（批次 38 回归）、apply_patch 移动与 /undo、/rewind 的
  不一致（批次 37 回归）、git 丢弃工作区命令的危险分类（批次 36 回归）、GUI 子代理调用
  跨会话写入（批次 30 回归）、/context 三行加和（批次 31 回归）、ask_user 单选多答（批次 32 回归）、
  NDJSON 事件流被权限提示污染（10-22 落地批次的契约回归）。
  只列真实、可复现的缺陷与最终防线，不列假设性风险。

## 范围与结论

| 轮次 | 攻击面 | 主要缺陷（已修复） |
| --- | --- | --- |
| 1 | 会话目标自动续跑 | 目标文本/校验器摘录可闭合 `<goal_state>` 标签注入顶层指令；校验期间目标被替换/清除仍吸收成本与判定 |
| 2 | 常驻 Node REPL | 无换行 stdout/stderr、待结算日志无界增长（后台刷屏可撑爆进程）；超大返回值原样返回模型 |
| 3 | apply_patch | 移动文件到自身会先写后删导致源丢失；多段补丁同时触碰同一路径/移动目标互相覆盖；带锚点的纯插入落在文件尾 |
| 4 | 错误信息脱敏 | 漏掉 Slack/npm/AWS/GCP/JWT/GitLab/私钥/邮箱等令牌族；Authorization 变体与 URL 查询参数中的密钥未清洗 |
| 5 | 入站图片降采样 | 解压炸弹（小文件声明巨幅位图）；未解码输入无绝对上限；BMP 头部尺寸未识别 |
| 6 | 会话/journal 保留清理 | `keepIds` 为数组时快照过期（长驻 GUI 打开的会话可能被删）；`lstat → unlink` 之间被恢复的会话仍被删；GUI 未接动态保护 |
| 7 | TUI `@` 文件提及 | 含空格/特殊字符路径静默不展开；凭据文件与符号链接逃逸；FIFO/超大文件无界读取；多字节截断产生 U+FFFD；`<file>` 属性未转义；git 路径多字节分片乱码且输出无上限 |
| 8 | 权限规则与复合命令 | 只读命令完全绕过显式 deny 规则；`git reflog expire/delete`、`git grep -O`、`git config --unset` 等被误判只读 |
| 9 | 流恢复与用量基线 | 上下文基线漏算缓存 token（缓存会话永不触发自动压缩）；锚点失效后陈旧 usage 未清除（resume 绑错历史）；OpenAI 续写中止时重叠文本重复写入历史；目标预算漏算缓存 token |
| 10 | 收尾复核 | 标题 sidecar、web_fetch 缓存、read_session 复核未发现可复现缺陷；顺带修复 cron 租约“未来 mtime 被判过期”导致的双所有者竞态 |
| 追加 | 只读工具提前执行（批次 31） | `task` / `send_message` / `message_parent` 权限上是只读，但有外部副作用；流重启后提前调用会被重跑，detached 子代理派发两次、消息投递两遍 |
| 追加 2 | 压缩后读状态恢复（批次 29） | “内容仍在保留尾部”只按绝对路径判断，而 `read_file` 结果用相对路径；刚读过的文件被重复完整注入，抵消压缩 |
| 追加 3 | Windows 树删除分类（批次 38） | `rd /s`/`rmdir /s`/`robocopy /MIR` 只看第一个词；`cmd /c`、PowerShell `-Command`、绝对路径 `rmdir.exe` 均漏判，auto 模式下树删除被静默放行 |
| 追加 4 | 大截图的流式输出上限（批次 29） | 提取器宣称支持 2×5 MiB 图片，但 bash 捕获在 200k 字符就杀进程：成功命令被标成失败，慢速输出还会截断 base64、附上残缺图片 |
| 追加 5 | tool_search 暴露的跨会话泄漏（批次 38） | 暴露集合是进程级 `Set`：同进程切换会话会继承其他会话的发现结果，且目标会话的隐藏目录里已看不到它；plan 模式还会列出未暴露的延迟工具、调用却被门禁拒绝 |
| 追加 6 | apply_patch 移动与撤销（批次 37） | move 在 unlink 源之前 finalize，checkpoint 记下移动前的源哈希，`/undo` 把 agent 自己的删除当成用户改动而拒绝；`--force` 恢复源后目标副本残留，`/rewind` 跨过移动时同样误报冲突 |
| 追加 7 | git 丢弃工作区命令（批次 36） | `git checkout -- .`、`git restore <path>`、`git stash drop/clear`、`git rm <file>` 未被危险模式识别，bash 以 medium 风险申请权限；auto 模式对非 high 请求静默放行，一条命令即可丢弃用户全部未提交改动 |
| 追加 8 | GUI 子代理调用跨会话写入（批次 30） | `onSubTool` 在事件到达时才读 `project.agent.sessionId`：detached 子代理在回合结束、用户已 `/resume` 到另一会话后完成，调用链被写进**新**会话的 `subcall` 行，原会话的调用链丢失 |
| 追加 9 | `/context` 三行加和（批次 31） | 有 provider 锚点时 history 残差被截为 0；若上次请求后工具集/系统提示变大（新接入大 schema MCP），system + tools 已超过旧 input，`/context` 三行之和大于显示的总量（实测 7,835 vs 17,841） |
| 追加 10 | ask_user 单选多答（批次 32） | 文档承诺“`multiSelect: true` 时才可多选”，但 `cleanSelected` 只过滤伪造 label、不裁剪数量：非规范客户端对单选问题回传两个 label 时，模型看到 “SQLite, Postgres” 两个答案 |
| 追加 11 | NDJSON 事件流被权限提示污染（10-22 落地批次） | 契约声明“stdout 每行一个 JSON 对象，仅此而已”，但终端里跑 `--output-format stream-json` 时 diff 预览用 `console.log`、readline 提示与按键回显绑在 `process.stdout`：人类文本夹进事件流，逐行 `JSON.parse` 的消费者直接崩；文档同时漏列 5 个已在发的事件类型 |

## 关键修复

### 1：会话目标自动续跑

- `escapeGoalTags` 把 objective、nextAction、note 以及校验器引用的上一轮助手输出中的
  `<goal_state>` / `<latest_turn>` 闭合标签转义为 `&lt;...`，历史文本或网页内容不能再
  提前结束提醒块、冒充顶层指令。
- 校验器返回后先做目标身份检查（`this.goal !== goal`），目标已被替换或清除时不把成本与
  判定记到旧目标上；回合失败时活动目标自动暂停并记录原因。

### 2：常驻 Node REPL

- stdout/stderr 的未换行缓冲区、单次请求的日志字符数都有 200,000 字符硬上限：超限直接
  失败并重启内核，而不是继续缓冲。
- 返回值/日志值超过 100,000 字符时截断并标注，避免一个 `console.log(bigObject)` 把整段
  数据塞回模型上下文。

### 3：apply_patch

- 移动目标与源路径相同直接拒绝：原实现先写目标再删源，同路径会删掉刚写入的内容。
- 移动目标已存在时报错，不做静默覆盖。
- 解析阶段检测冲突段：两个 section 写同一路径（含 update/delete/move 目标交叉）时整体
  拒绝，避免后一段覆盖前一段的结果。
- 纯插入 hunk 带上下文锚点时插在锚点行之后；只有无锚点的 hunk 才追加到文件尾。

### 4：错误脱敏

- 新增令牌族：Slack（`xox[abposr]-`）、npm、AWS access key（`AKIA`）、Google API key
  （`AIza`）、GitLab PAT（`glpat-`）、GitHub PAT（`ghp_` / `github_pat_`）、JWT（`eyJ...`）、
  PEM 私钥整段；通用 `sk-/rk-/pk-` 与 `sk_live_/sk_test_` 保持覆盖。
- `Authorization:` 及其引号/等号变体统一替换为 `{redacted}`；URL 只保留
  `protocol//host/path`，查询串中的 api_key/token/secret 等不会再进入日志或 GUI 错误行。
- 邮箱、用户目录（`/Users|/home|/root|...`、`/tmp`、Windows 盘符路径）与长 id 路径段一并
  泛化；控制字符折叠后截断到 2,048 字符。

### 5：图片降采样

- 解码前从 PNG/JPEG/GIF/BMP 头部读尺寸，超过 2,400 万像素直接拒绝，阻断「小文件声明
  巨幅位图」的解压炸弹；无法测量尺寸且格式不明的超预算 payload 不交给解码器。
- 新增 64 MiB 解码前输入硬上限，配置的字节预算再大也不能让进程先吃下数百 MB。
- BMP 头部尺寸（含负高度 top-down 位图）纳入识别，超预算的 BMP 能正常降采样而不是原样
  透传给模型。

### 6：会话/journal 保留清理

- `keepIds` 支持函数形式，在清理真正执行时求值：GUI 通过
  `() => [backend.gui.currentSessionId()]` 保护「调度之后才打开」的会话。
- 删除前二次 `lstat`，期间被追加/恢复（mtime 变新）的会话跳过；只删普通文件，符号链接
  与目录不动。
- 保留 id 同时匹配原值与 journal 文件名清洗后的变体。

### 7：TUI `@` 文件提及

- 补全含空格/逗号/括号的路径时自动加引号（`@"my file.txt"`），解析器接受未闭合引号作为
  输入中的提及，已闭合引号视为最终文本；文件名本身含 `"` 时不加引号，避免无法解析。
- 展开前做词法包含检查 + `realpath` 复查：拒绝凭据文件（`isSensitivePath`）和指向仓库外
  的符号链接；只接受普通文件，FIFO 等特殊文件不会被打开阻塞。
- 读取上限为剩余预算 +1 字节，含 NUL 的二进制直接跳过；按字节预算截断并在 UTF-8 边界
  回退，不再产生 U+FFFD；`<file path="...">` 属性做转义；只有真正截断才追加标记。
- `git ls-files` 输出先按 Buffer 分片收集再统一 UTF-8 解码（多字节字符跨 chunk 不再乱码），
  上限 8 MiB，超限报错而不是无限缓冲。

### 8：权限规则与复合命令

- 只读请求不再直接返回 true：仍跳过询问，但先检查结构化规则，显式 deny（如
  `bash(cat .env:*)`）优先；yolo 模式除外。无头/MCP 的 `askPermission` 以
  `request.readOnly === true` 放行，语义与交互端一致。
- `isReadOnlyCommand` 收紧 git 分支：`reflog` 只允许查看类子命令，`config` 只允许
  `--get/--list`，参数含 `-O`、`--open-files-in-pager`、`--output` 时一律视为有副作用。

### 9：流恢复与用量基线

- `TokenCounter.setAnchor` 增加缓存 token 参数，锚点 = 新鲜输入 + 缓存读/写 + 输出。
  Anthropic 的 `input_tokens` 不含缓存项、OpenAI 后端已从 `prompt_tokens` 扣除缓存项，
  此前缓存命中越多基线越低，长会话可能直到上下文溢出都不触发自动压缩。
- `persistTurn` 在锚点已被失效（压缩、裁剪、媒体剔除）且本轮没有新基线时写入
  `usage: null`，删除会话元数据中的旧基线；否则 resume 会把旧 token 数绑到已被改写的历史。
- 恢复流在用户中止时用 `mergeText` 合并两次尝试的文本：OpenAI 无 prefill，续写会从头发
  送，原实现直接拼接会把重叠段落重复写进历史；Anthropic 的 prefill 续写则退化为追加。
- 目标 token 预算与校验器成本同样计入缓存读/写 token，缓存命中不再让预算长期虚低。

### 10：收尾复核

- 复核会话标题 sidecar（生成结果只写一次、用户重命名优先、跨会话捕获 sessionId）、
  web_fetch TTL+LRU 缓存（仅成功响应入缓存、命中前不重新校验但条目入缓存时已校验）、
  read_session（预算裁剪、无查询时取最新回合、明确标注为不可信数据），未发现可复现缺陷。
- 全量回归时定位到 `tests/cronScheduler.test.ts` 间歇失败（本机 8 次跑出 5 次失败）：
  `leaseIsFresh` 要求租约年龄 ≥ 0，而 Windows 的 `mtimeMs` 带亚毫秒向前舍入，实测
  `Date.now() - mtimeMs` 会在 -0.07ms 到 -3.1ms 之间为负。于是活租约被判过期：待命用例
  直接抢占，并发启动用例里败者删掉胜者租约后重试成功，出现两个所有者。修复为负年龄一律
  视为新鲜（接管是危险动作，不确定时应待命），并用 `fs.utimes` 把 mtime 设到未来 60 秒
  的确定性用例锁定该行为。

### 追加：只读提前执行的可重放性

- 批次 31 的提前执行按 `isReadOnly && parallelSafe` 过滤，并假设“只读 ⇒ 重跑无副作用”。但
  `task`（派生子代理）、`send_message` / `message_parent`（投递消息）是为了权限才标记只读的，
  执行本身有外部副作用。实测：脚本流通过 `onToolReady` 提前发出
  `task {run_in_background:true}`，随后 `onStreamRecovery(restart)` 丢弃本次响应；重启后的
  正常波次再次执行同一调用，`subagentTasks.start` 被调用两次——两个 detached 子代理并行做
  同一件事，worker 模式还可能重复改文件。
- 修复：`Tool.earlySafe?: boolean`（默认 true，语义是“丢弃重试后可安全重跑”）。`onToolReady`
  额外要求 `earlySafe !== false`；`task`、`send_message`、`message_parent` 显式设为 false。
  纯读取工具（read_file/grep/glob/web_fetch/read_session 等）行为不变。
- 回归：`tests/agent.test.ts` 的 “does not early-start a side-effecting tool that merely reports
  read-only” 监视 `subagentTasks.start`，断言一次重启后只派发一次。

### 追加 2：压缩后读状态恢复的“仍在尾部”判定

- 批次 29 的 `buildReadStateReminderBody` 用“尾部文本是否包含读取记录的路径”来决定跳过，
  但只匹配**绝对路径**；`read_file` 的工具结果第一行是工作区**相对路径**，绝对路径可能
  从未出现在历史里。实测：刚读过、结果仍在压缩保留尾部的文件，压缩后又被完整注入一次
  （最多 5 个文件 / 48k 字符），直接抵消压缩效果，甚至可把上下文顶回预算线触发再次压缩。
- 修复：同时匹配「tool_result JSON 的 `content` 前缀 + 相对路径 + 换行」这一工具结果表头
  （含 JSON 转义形式，Windows 反斜杠翻倍），只匹配表头而不是裸路径，避免一句无关提及就
  误跳过导致“凭记忆编辑”。
- 回归：`tests/contextRestore.test.ts` 的两条用例：相对路径表头仍在尾部 → 不重复注入；
  散文里只提到路径 → 仍恢复内容。

### 追加 3：Windows 树删除分类的包装绕过

- 批次 38 的 `isWindowsDestructiveDelete` 只把 `tokens[0]` 当命令词。实测
  `cmd /c rd /s /q C:\proj\build`、`powershell -Command "rd /s …"`、
  `C:\Windows\System32\rmdir.exe /s …` 全部返回 false：在 auto（accept edits）模式下
  非 high 风险直接放行，等同于树删除不弹审批；主 bash 也不会标注 `[matches a dangerous pattern]`。
- 修复：命令词按「去引号/`@`、取路径末段、去 `.exe`」归一化后在整条命令里查找，而不是只看
  首个 token；`/S`、`/?`、`/MIR|/PURGE`、`/L`、`/XF|/XD` 的判定逻辑不变。宁可误报多问一次，
  也不漏报危险删除。
- 回归：`tests/bash.test.ts` 的 “flags tree deletes behind a shell wrapper or an absolute
  executable path” 覆盖 cmd、cmd.exe、PowerShell 与绝对路径四种写法。

### 追加 4：大截图的流式输出上限

- 批次 29 的 data-URL 图片提取宣称支持单图 5 MiB、每次至多 2 张，但主 bash 的流式捕获在
  `out.length > 200_000` 时就 `killTree` 并标记失败。实测一条成功的
  `node -e "process.stdout.write('data:image/png;base64,' + 'A'.repeat(400000))"` 返回
  `isError: true`（“output exceeded 200KB; exit code 0”）；输出更快/更大时 base64 会在中途
  截断，仍会按“≥100 字符”规则附上一张残缺图片。
- 修复：流式检测 `data:image/`（跨 chunk 保留 10 字符尾巴），命中后把上限放宽到
  「200k 文本 + `imageCaptureChars()`」（= 2 × 5 MiB 的 base64 长度），kill 提示使用当前
  生效的上限；未出现图片标记时行为不变。
- 回归：`tests/bash.test.ts` 的 “captures a screenshot larger than the plain-text output cap”
  断言 400k base64 的截图命令不报错、生成 1 个图片块并留下占位文本。

### 追加 5：tool_search 暴露的跨会话泄漏

- 批次 38 把 tool_search 的发现结果持久化进 `SessionMeta.exposedTools`，但内存里的暴露集合仍是
  进程级 `Set`。实测（同进程切换会话）：会话 A 用 `tool_search select:` 暴露某延迟工具后切到
  从未发现它的会话 B，B 的 tool 列表直接出现该工具，而 B 的 `deferredTools()` 已把它从隐藏目录
  移除——B 既无法自行发现，也无从得知为何可见；MCP server 的多个 `agent_chat` 同理。
- 同时发现 plan 模式（`activeTools`）列出**全部**只读工具而不看暴露状态：未暴露的延迟工具出现在
  工具表里，直接调用却命中 `runTool` 的 deferred 门禁，白费一轮。
- 修复：暴露集合改为 `Map<sessionId, Set<name>>`；`persistTurn` / `loadSessionMeta` / `runTool` /
  系统提示的 deferred 判断都带当前会话 id；`unregisterToolsByPrefix` 清理所有会话；plan 模式与
  非 plan 模式共用同一 `isExposed(name, sessionId)` 过滤。
- 回归：`tests/toolSearch.test.ts` 的 “scopes exposure to the session that discovered the tool”；
  `tests/agent.test.ts` 的 “scopes exposures to the session that discovered them” 与
  “keeps unexposed deferred tools out of the plan-mode tool list”。

### 追加 6：apply_patch 移动与 /undo、/rewind

- 批次 37 的 move 执行顺序是「写目标 → finalize checkpoint → unlink 源」。finalize 因此把
  **移动前**的源内容记为 post 状态；`/undo` 的冲突检测发现源路径已不存在，判定为
  “the file was deleted or moved after the agent's edit” 并拒绝——明明移动就是 agent 自己做的。
  加 `--force` 可以恢复源，但目标副本从未进入检查点，撤销后工作区里两份内容并存；
  `/rewind` 跨过移动时也因为同一个 post 哈希（或缺失的目标条目）误报冲突或漏删目标。
- 修复：move 的 checkpoint 带 `movedTo`，finalize 改到 unlink 源之后执行（源记
  `postExisted=false`，目标记 `movedToHash`）。`undoLast` 先校验目标副本（被用户改过则拒绝），
  通过后恢复源并删除目标；`rewindTo` 把目标视为 agent 创建的文件：冲突检测用 `movedToHash`，
  恢复阶段删除目标，源仍按最早 pre-image 恢复。add/update/delete 的既有行为不变。
- 回归：`tests/patchTool.test.ts` 的 “undo after a move restores the source and removes the
  moved copy”（修复前 `undoLast` 返回 conflict）；`tests/checkpoint.test.ts` 的
  “undo of a move restores the source and deletes the moved-to copy”“refuses to undo a move
  when the moved-to copy was modified”“rewinds a move plus later edits to the moved file”。

### 追加 7：git 丢弃工作区命令的危险分类

- 批次 36 的危险模式只覆盖 `push --force` / `reset --hard` / `clean -`。实测
  `git checkout -- .`、`git restore src/app.ts`、`git stash clear`、`git rm src/app.ts`
  都返回 `isDangerousCommand === false`，bash 以 `medium` 风险请求权限；而 auto（accept
  edits）模式对非 high 请求直接放行——一条命令就能静默丢弃用户全部未提交改动。
- 修复：新增 git 危险模式——路径 checkout（`--` 或 `.`）、强制 checkout/switch
  （`-f/--force/--discard-changes`）、工作区 restore（仅 `--staged`/`-S` 的纯取消暂存放行；
  `--worktree`/`-W`/`--source`/`-s` 一律危险，短选项区分大小写）、`stash drop|clear`、
  `git rm`（`--cached` 只取消暂存，保持放行）。普通分支切换（`checkout <branch>`、`-b`、
  `switch <branch>`）不受影响。
- 回归：`tests/bash.test.ts` 的 “flags git commands that discard uncommitted work or delete
  tracked files”（12 正例 / 9 反例）与 “asks with high risk for git commands that discard
  uncommitted work”（修复前风险为 `medium`）。

### 追加 8：GUI 子代理调用跨会话写入

- 缺陷：GUI 的 `onSubTool` 在事件到达时才读 `project.agent.sessionId` 来追加 UI-only 的
  `subcall` 行。`task` 的 detached 子代理持有父回合的事件闭包，回合结束后仍会继续跑；
  此时 `/api/resume` 不再被 `busy` 拦住，用户切到另一会话后子代理才完成，调用链就被
  写进新会话文件，而原会话的卡片在重启/重开后无法重建。修复前用假 agent 复现：回合结束
  后把 `sessionId` 从 `sess1` 改成 `sess2` 再触发 `onSubTool`，落盘参数为 `sess2`。
- 修复：`buildEvents` 在 turn 存活期间（`runtime.liveTurn === turn`）记住所属会话 id；
  `onRoundStart` / `onSubToolStart` 时刷新（新会话的 id 由 `chat` 内的 `ensureSession`
  在首轮前创建，开始时可能为空），`onSubTool` 落盘只用记住的值。回合结束后不再刷新，
  所以迟到的子代理报告仍归原会话。
- 附带修复：归属会话在迟到报告到达前已被删除时，`appendSubCall` 的 `appendFile` 会重建
  一个没有 meta 行的孤儿文件（`listSessions` / 加载器都会忽略，但文件永久残留）。现在
  与 `deleteSession` 共用文件锁，在锁内先 `access` 再追加；文件不存在则跳过。
- 回归：`tests/guiServer.test.ts` 的 “persists a detached subagent call to the session that
  owned the turn”（修复前落盘 `sess2`）与 “persists subagent calls to the session the agent
  creates on a first turn”（锁定首轮延迟建会话仍能落盘）；`tests/session.test.ts` 的
  “does not resurrect a deleted session when a late subcall arrives”（修复前文件被重建）。

### 追加 9：/context 三行加和

- 缺陷：`contextBreakdown()` 在有 provider 锚点时用 `history = max(0, input − system − tools)`
  兜底。锚点只描述**上一次实际发送**的请求；两次请求之间工具集或系统提示变大（GUI 新接入一个
  大 schema 的 MCP 服务器、记忆文件变长）时，`system + tools` 已经超过旧 input，history 被截
  为 0，`/context` 的三行之和反而大于显示的总量，与文档声明的“相加恒等于 input”相悖。复现：
  用首轮估算值作为 provider 计数，随后注册一个 40k 字符描述的工具，三行之和 17,841 而 input
  仍显示 7,835。
- 修复：有锚点时 `input = max(tokenEstimate(), system + tools)`（无锚点仍为三者相加）。计数
  正常时 provider 值更大、语义不变；提示变大时退化为当前提示的估算下界，保证三行仍然相加
  等于 input。
- 回归：`tests/agent.test.ts` 的 “stays additive when the tool set grows after the provider
  anchor”（修复前三行之和与 input 不等）。

### 追加 10：ask_user 单选多答

- 缺陷：文档约定 `multiSelect: true` 才可多选，但回传清洗 `cleanSelected` 只按 label 过滤伪造
  选项、把命中项全部按选项顺序输出。GUI 前端用 radio 保证单选，`/api/answer` 却是原始
  JSON 边界：脚本或未来的客户端对单选问题回传 `["Postgres", "SQLite"]`，模型会收到
  “Which database? → SQLite, Postgres”，与“二选一”的提问语义相悖。
- 修复：`cleanSelected` 在 `multiSelect !== true` 时只保留选项顺序中的第一个命中项；多选行为
  不变。选项顺序（而非提交顺序）作为仲裁口径，与既有的“按选项原始顺序输出”一致，结果不受
  客户端提交顺序影响。
- 回归：`tests/askUser.test.ts` 的 “keeps a single choice for a single-select question”
  （修复前输出 `SQLite, Postgres`）。

### 追加 11：NDJSON 事件流被权限提示污染

- 缺陷：`docs/headless-ndjson.md` 承诺 `-p --output-format stream-json` 下“stdout 每行一个 JSON
  对象，仅此而已；人类可读诊断仍走 stderr”。但 `runPrint` 的权限询问只在文本模式下成立：交互
  TTY + stream-json 时，diff 预览走 `console.log`（stdout），readline 以 `output: process.stdout`
  创建——提示串与按键回显同样落在 stdout。消费者的逐行 `JSON.parse` 会在权限行上抛错，而这是
  契约里唯一的交互点。管道/重定向（非 TTY）不提问，因此只在终端里暴露。
- 修复：`createNdjsonEvents()` 增加第三个可注入参数与 `human()` 出口（默认写 stderr）；
  `runPrint` 在 stream-json 下把 readline 的输出流与预览文本都指向 stderr。事件流本身不变。
- 顺带补全契约文档：原表漏列实际在发的 `sub_tool_start`、`session_title`、`goal_changed`、
  `goal_checking`、`stream_recovery` 与 `permission.rule`；`src/headless.ts` 的头注释同样缺
  `thinking_delta`、`stream_recovery`、`cost_warning`、`hook`、`plan_approved`。
- 回归：`tests/headless.test.ts` 的 “keeps permission-prompt text out of the NDJSON stream”
  （人类文本永不进入注入的事件写出器）与 “sends human diagnostics to stderr when no sink is
  injected”（默认写出到 stderr，且没有碰 `process.stdout`）。

### 复核：ask_user 的中断优先级

- 怀疑 TUI 传输层在 abort 时返回 `{timedOut:true}` 会盖过 Agent 的 `{aborted:true}`，让历史
  记录“问题超时，自行决策”而不是“回合被中断”。按 TUI 的真实写法构造用例后未能复现：
  `handler(...).catch(...)` 多出的一次微任务让 `aborted` 先赢得 `Promise.race`。未改生产代码，
  仅新增用例锁定该优先级（`tests/agent.test.ts`，“reports an interrupted turn even when the
  transport resolves a timeout on abort”）。

## 验证

- `npx vitest run`：90 个文件，1298 passed / 8 skipped；`cronScheduler.test.ts` 连续
  12 次单独运行全部通过（修复前 8 次失败 5 次）。
- `npx tsc --noEmit`、`npm run lint`、`npm run build` 均通过。
- 新增回归覆盖：`tests/goal.test.ts`、`tests/nodeRepl.test.ts`、`tests/patch.test.ts`、
  `tests/errorSanitizer.test.ts`、`tests/imageResize.test.ts`、`tests/retention.test.ts`、
  `tests/mentions.test.ts`、`tests/commands.test.ts`、`tests/bash.test.ts`、
  `tests/permissions.test.ts`、`tests/tokens.test.ts`、`tests/llmCancel.test.ts`、
  `tests/agent.test.ts`、`tests/cronScheduler.test.ts`、`tests/contextRestore.test.ts`、
  `tests/toolSearch.test.ts`、`tests/patchTool.test.ts`、`tests/checkpoint.test.ts`、
  `tests/guiServer.test.ts`、`tests/session.test.ts`、`tests/askUser.test.ts`、
  `tests/headless.test.ts`。
