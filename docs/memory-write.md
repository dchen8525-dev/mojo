# 记忆写入侧：save_memory 工具、自动提取与 /dream（批次 28，2026-10-22）

## 背景

批次 13（memory-recall.md）落地了记忆的读取侧：系统提示注入 + 召回。批次 15 的 `subagent-persistent-memory.md` 给命名子代理加了独立记忆文件。但主代理此前没有任何写入 `.node-agent/memory.md` / `~/.node-agent/memory.md` 的通道——记忆文件只能靠用户手编。本批次补齐写入侧，参照 ZCode 的三层模型：

1. 前台工具写入（模型显式保存）；
2. 回合后自动提取（后台 LLM 调用判断对话里是否有值得长期记住的事实）；
3. Dream 式整理（把零散章节合并成整洁文件——ZCode 中实现了但刻意未接线，这里改为显式用户命令）。

## 实现

新增 `src/memoryWrite.ts`：

### 1. save_memory 工具（前台写入）

- 注册进全局工具表（`src/tools/index.ts`），schema：`heading?`、`note`（必填）、`scope: "project" | "user"`（默认 project）。
- 执行时先 `askPermission("Save a note to … long-term memory", "low", 预览)`，拒绝则不写。
- 写入走 `upsertMemorySection(file, heading, note)`：按 `## 标题` 定位章节，存在则把笔记追加到该章节最后一个非空行之后（保留下一个标题前的空行分隔），不存在则在文件末尾新建章节；完全相同的（标题+笔记）原样跳过；标题做空白归一化并截断到 80 字符，笔记截断到 8000 字符。
- 复用读取侧的防御：lstat 拒绝符号链接文件（防仓库植入 `memory.md → 秘密文件` 的 symlink），写盘走 `atomicWriteFile`，空行连续 3+ 压缩为 1。

### 2. 回合后自动提取（opt-in）

- 开关：环境变量 `AGENT_MEMORY_EXTRACTION=1`（与 `AGENT_JOURNAL=1` 同类先例——每回合多一次 LLM 调用，默认关闭）。
- `Agent.chat()` 成功返回后调用 `scheduleMemoryExtraction(userText, finalText)`，跳过条件：本回合已用过 save_memory（`saveMemoryThisTurn` 标记，runTool 里置位）、用户输入不足 3 个词、助手回复为空。
- 提取任务经 `scheduleMemoryJob` 调度：**同一时刻至多一个任务在跑；排队中的请求只保留最新一个**（burst 合并），失败静默吞掉，`waitForMemoryJobs()` 是测试排空钩子。
- 每个任务 = 一次独立 LLM 调用（`EXTRACTION_SYSTEM` 策展提示 + `buildExtractionPrompt` 携带当前章节标题列表与裁剪到 6000 字符的 `<user>`/`<assistant>` 块），要求只回 JSON 数组 `[{"heading","note"}]`。
- `parseExtractionReply` 宽松解析（取首 `[` 到末 `]`），最多 5 条，无 note 的条目丢弃。
- **模型永远不直接重写记忆文件**：`applyExtraction` 把每条 JSON 条目交给确定性的 `upsertMemorySection` 落盘，返回写入描述。
- 打印模式（`-p`，含 cron 复用的同一路径）在 `runPrint` 开头 `disableMemoryExtraction()`——headless 运行绝不在用户背后写记忆。

### 3. /dream 整理命令（显式、两段式）

- `/dream`：要求项目记忆非空；一次 LLM 调用（`DREAM_SYSTEM`：合并重复章节、按日期解决矛盾、相对日期转绝对、删除过时内容）产出完整 markdown 提案，写入 `.node-agent/memory.dream.md`；命令回显行数 + 40 行预览，提示 `/dream -y`。
- `/dream -y`：应用待定提案——当前文件先 `copyFile` 备份为 `memory.md.bak`（尽力而为），再原子替换，删除提案文件。
- `/dream` 只是提案，绝不自动应用；ZCode 里 dream 是"实现了但未接线"，这里以显式命令 + 用户确认的形态接上。

### 接线清单

- [src/agent.ts](../src/agent.ts)：chat() 末尾调度提取；`dreamPropose/dreamApply/hasProjectMemory/peekDream` 四个 Agent 方法；runTool 检测 save_memory 置位跳过标记。
- [src/agentCommands.ts](../src/agentCommands.ts)：`case "dream"`；`BUILTIN_COMMANDS` 与 /help 文本加入 `/dream [-y]`。
- [src/tools/index.ts](../src/tools/index.ts)：注册 `saveMemoryTool`。
- [src/cli.ts](../src/cli.ts)：runPrint 调用 `disableMemoryExtraction()`。
- [src/gui/static/app.js](../src/gui/static/app.js)：命令面板加 `["/dream", "整理项目记忆（-y 应用提案）"]`。

## 测试

`tests/memoryWrite.test.ts`（16 例）：

- upsert：新建文件与章节、既有章节内追加（含空行分隔保持）、完全重复跳过、标题/空行归一化、symlink 拒绝（非 Windows）。
- listMemoryHeadings：标题提取 + 缺文件容忍。
- saveMemoryTool：空 note 拒绝、授权后写入项目记忆、未授权不落盘。
- parseExtractionReply：散文夹 JSON、空数组/非法 JSON/非数组返回 []、无 note 丢弃、5 条封顶。
- buildExtractionPrompt：标题列表 + 截断标记。
- 调度器：串行执行 + pending 合并为最新、错误吞掉。
- applyExtraction：写入描述与落盘。
- dream 往返：提案→peek→应用（含 .bak 回读、提案消费）；空记忆/模型失败/null 传播。

`tests/agentCommands.test.ts`：/dream 提案+预览+应用、无提案拒绝、空记忆报错、提案失败报错（fakeAgent 补齐 4 个 mock）。

全量：938 通过 / 7 跳过；`npm run lint`、`npm run build` 通过。

## 边界与不改动的部分

- 用户级记忆（scope=user）写入 `~/.node-agent/memory.md`，同样走 upsert；测试不触碰真实家目录。
- 提取开关关闭时 chat() 的行为与此前完全一致（早退，零开销）。
- 读取侧（memory.ts 的注入/召回/512KiB 窗口）未动；写入侧的 512KiB 前端裁剪属后续观察项。
