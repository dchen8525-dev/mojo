# mojo

一个用 Node.js + TypeScript 构建、运行在终端里的、类似 Claude Code 的 AI 编程智能体。

它驱动一个智能体循环（上下文组装 → 调用 LLM → 执行工具 → 回填结果），并配备文件工具、
Shell 访问、权限控制、会话持久化、多模型支持、子智能体、MCP、钩子（hooks），以及基于
Ink 的交互式 UI。

## 特性

- **智能体循环**：每轮最多 40 次工具迭代，输出被截断时自动续写；上下文窗口接近占满时
  触发 LLM 摘要式压缩（结构化的交接笔记会保留任务、决策、涉及文件与未完成任务；
  `/compact` 可手动触发）
- **内置工具**：`read_file`、`write_file`、`edit_file`、`multi_edit`（跨文件批量
  替换：glob 选文件 + 字面/正则搜索，合并 diff 一次确认，逐文件快照可 `/undo`）、
  `bash`（含 `run_in_background` 后台任务 + `bash_output` / `bash_kill`）、`glob_files`、
  `grep`、`todo_write`、`task`（研究 / 编码双子智能体）、`get_diagnostics`、
  `web_search` / `web_fetch`（查文档、跟报错）、`git_status` / `git_commit` / `git_pr`
- **Web 工具**：`web_search`（DuckDuckGo）+ `web_fetch`（HTML 转纯文本，超时与体积
  上限、拒绝非 http(s)），让智能体能查文档、跟陌生报错的解法
- **上下文压缩三段式**：先免费预剪枝陈旧的 `tool_result` 输出（常足以回到预算内），
  再 LLM 摘要（多次压缩时把上一份交接笔记折叠进新摘要，信息不衰减），摘要调用接入
  `ctx.signal` 可被 Esc 取消；失败回退按交换分组截断
- **自动记忆**：每次压缩产生的交接摘要追加到 `.node-agent/memory.md`（用户级
  `~/.node-agent/memory.md` 同样注入），新会话自动进系统提示词——决策与坑跨会话延续
- **Plan 模式**：`/plan` 或 `--plan` 开启后只暴露只读工具 + `exit_plan`；智能体探索
  后提交完整计划，用户批准才切回执行模式（拒绝则留在 plan 模式继续修订）
- **`/review` 代码审查**：收集未提交改动或 `<base>...HEAD` 区间的 diff（含小的未跟踪
  文件），交给模型按严重级别输出可执行的审查意见
- **Git 工作流护栏**：专用 git 工具比裸 `bash git` 更安全——拒绝在 `main`/`master`
  直接提交、拦截 `.env`/私钥等敏感文件、提交前展示 staged diff、用户拒绝时还原索引、
  PR 拒绝脏工作区且永不 force push
- **文件快照与撤销**：`write_file`/`edit_file` 修改前自动快照到
  `~/.node-agent/checkpoints/`，`/undo` 逐步回滚（含删除代理新建的文件），无需依赖 git
- **宽容的 `edit_file`**：先尝试精确匹配，失败后退回到忽略空白的匹配，并把替换文本重新
  缩进以贴合文件；再失败则返回最接近的匹配区域，让下一次尝试更精准。每次编辑都会返回
  统一的 `<diff>`（权限确认提示中同样展示），让你在批准前确切看到改了什么
- **并行工具执行**：只读 / 子智能体工具并发运行；有副作用的工具保持串行
- **权限系统**：读操作自动放行，写操作和危险命令需要确认；`y` / `a`（总是允许）/
  `d`（总是拒绝）/ `n`，规则可持久化，另有 `--auto` 与 `--yolo` 模式
- **多模型**：Anthropic 与 OpenAI（Chat Completions）后端，`/model` 热切换，支持别名
  （`sonnet` / `opus` / `haiku` / `gpt`），按模型区分上下文窗口
- **流式输出 + 断点恢复**：被中断的流从已产出的部分继续，而不是重发整个请求；瞬时 API
  故障带退避重试
- **精确的 token 统计**：以 API 返回的精确用量为锚点，加上对 CJK 友好的增量估算——压缩
  基于真实数字触发，而不是简单的字符数/3.5
- **成本统计与预算护栏**：按模型（含 prompt 缓存读写）聚合会话美元成本，`/cost` 查看、
  `/cost <usd>` 或 `AGENT_BUDGET_USD` 设预算；用到 80% 告警、耗尽时干净终止当前轮次
  （为未执行的 tool_use 回填错误结果，历史保持合法）
- **会话持久化**：JSONL 格式存于 `~/.node-agent/sessions/`，`/sessions` + `--resume`
- **图片输入**：`Ctrl+V` 直接粘贴剪贴板截图（Windows / macOS / Linux）
- **`@file` 引用**：把文件内容内联进你的提示词（`@src/foo.ts`、`@"my file.txt"`）
- **自定义斜杠命令**：`.node-agent/commands/*.md` 中的 markdown 提示词模板
- **钩子（Hooks）**：在 `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` 时机
  执行 shell 命令
- **MCP 客户端**：从 `~/.node-agent/mcp.json` 或 `.mcp.json` 连接 stdio 服务器
- **MCP 服务器模式**：`agent --mcp-server` 把 mojo 自身暴露为 MCP server（只读工具 +
  `agent_chat` + 项目资源），供其他代理编排调用
- **项目指令**：`AGENTS.md` / `CLAUDE.md` 会被注入系统提示词

## 安装

```bash
npm install
npm run build
npm link        # 暴露 `agent` 命令，或者直接使用: node dist/cli.js
```

需要 Node.js >= 20。

## 配置

### 配置分层

配置采用两层合并，**按 key 逐层覆盖**（与 hooks / lsp / mcp 的分层惯例一致）：

| 层 | 位置 | 用途 |
| --- | --- | --- |
| 全局 | `~/.node-agent/config.json` | 个人凭据与默认模型，对所有项目生效 |
| 项目 | `<cwd>/.node-agent/config.json` | 团队共享的项目级默认值（模型、网关地址等） |

完整解析优先级（从高到低）：

1. 命令行显式参数（`--model` / `--provider`）
2. 会话内 `/model` 热切换
3. 环境变量：`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`、`AGENT_MODEL`、`AGENT_PROVIDER`、
   `AGENT_BASE_URL`（或按 provider 的 `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`）
4. 项目级 `.node-agent/config.json`
5. 全局 `~/.node-agent/config.json`
6. 内置默认值

覆盖是**逐 key** 的：项目文件只写 `model` 时，`apiKey`、`provider` 等仍取全局值。
文件带 UTF-8 BOM（Windows 编辑器常见）或 JSON 损坏时不会崩溃——损坏的那一层被跳过，
其余层照常生效。

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "baseURL": "https://api.anthropic.com",
  "apiKey": "sk-..."
}
```

> 提示：项目级文件常被提交到 git。建议只放非敏感项（model / baseURL / provider），
> `apiKey` 留在全局配置或环境变量里；即便误提交，`git_commit` 工具也会拦截
> `.env`、`credentials` 等敏感文件名。

任何 OpenAI 兼容网关都可以通过 `--provider openai` 配合 `AGENT_BASE_URL` 环境变量
（或配置文件里的 `baseURL`）使用。

**示例 1 —— 个人全局配置 + 项目覆盖模型**

`~/.node-agent/config.json`（放凭据，不进 git）：

```json
{ "provider": "anthropic", "apiKey": "sk-ant-..." }
```

某公司项目的 `.node-agent/config.json`（提交到 git，团队共享）：

```json
{ "model": "claude-opus-4-1", "baseURL": "https://llm-gateway.corp.example/v1" }
```

在该目录下启动 `agent`：provider/apiKey 取全局，model 与 baseURL 被项目覆盖。
换到别的项目目录则回到全局默认。

**示例 2 —— 临时换网关（环境变量压过两层文件）**

```bash
# macOS / Linux
AGENT_BASE_URL=https://mirror.example/v1 agent -p "hello"

# Windows PowerShell
$env:AGENT_BASE_URL = "https://mirror.example/v1"; agent -p "hello"
```

**示例 3 —— 验证最终生效的配置**

启动后输入 `/model`（无参数）会显示当前 `provider:model` 与上下文窗口；
缺 key 报错时的提示语会指明该去哪个文件补配置。

### Windows 兼容

`bash` 工具在 Windows 上自动选择 shell，优先级如下：

1. `AGENT_SHELL`——显式指定：`cmd`、`powershell` 或 `pwsh`（可写全路径，如
   `C:\Program Files\PowerShell\7\pwsh.exe`）
2. `COMSPEC`——若你的系统默认 shell 指向 PowerShell，则跟随它
3. 兜底：`cmd.exe`

```powershell
# 让 bash 工具用 PowerShell 7 执行命令
$env:AGENT_SHELL = "pwsh"
```

PowerShell 以 `-NoProfile -NonInteractive -Command` 启动：不加载个人 profile（更快、
无副作用）、不弹交互提示。注意 Windows PowerShell 5.1 不支持 `&&`，写命令时用 `;`
分隔；智能体默认按 cmd 语法给命令，遇到失败会自行调整。

其他 Windows 相关行为：

- **危险命令检测跨 shell**：cmd（`del`、`taskkill /F`、`icacls`）、bash（`rm -rf`、
  `sudo`）与 PowerShell（`Remove-Item -Recurse -Force`、`Stop-Process`、
  `iwr … | iex`、篡改 Defender 的 `Set-MpPreference`）写法都会触发高风险提示。
- **进程树终止**：超时 / 取消 / 输出超限时，Windows 上用 `taskkill /T /F` 杀掉整棵
  子进程树（cmd → node → …），不会留下孤儿进程。
- **路径处理**：`workdir` 参数接受相对或绝对路径（自动按 `\` / `/` 规范化）；含引号
  的命令按 cmd 语义原样传递，规避 Node 默认转义与 cmd 不兼容的问题。

**示例 1 —— 固定使用 PowerShell 7（对所有会话生效）**

```powershell
# 写入用户级环境变量，之后启动的 agent 都用 pwsh 执行 bash 工具命令
[Environment]::SetEnvironmentVariable("AGENT_SHELL", "pwsh", "User")
```

**示例 2 —— 仅当前会话切换 shell**

```powershell
$env:AGENT_SHELL = "cmd"   # 本会话内改回 cmd.exe
agent
```

**示例 3 —— 智能体在 PowerShell 下的典型命令**

设置 `AGENT_SHELL=pwsh` 后，若智能体仍给出 cmd 风格命令（如 `dir && echo done`），
PowerShell 5.1 会直接报解析错，智能体读到错误后自行改用 `;` 分隔重试——整个过程
不需要你干预；危险写法（如 `Remove-Item -Recurse -Force`）则始终会先弹出高风险确认。

**示例 4 —— 指定工作目录运行命令**

智能体调用 `bash` 时传 `workdir`（相对或绝对路径均可）：

```json
{ "command": "npm test", "workdir": "packages\\core" }
```

### 工具输出截断与分页

- **head + tail 截断**：超过上限的输出保留开头 75% 与结尾 20%（报错和摘要通常在
  结尾），中间以 `[... N characters omitted …]` 标记，并给出总长度与恢复指引。
- **bash 溢出落盘**：输出超过 `max_output`（默认 30,000 字符，硬上限 200 KB）时，
  完整内容保存到系统临时目录（`node-agent-output/bash-*.txt`），返回值末尾附路径，
  可继续用 `read_file` 精确读取被截掉的中间部分。
- **read_file 分页**：返回被截断时末尾直接提示下一次调用的 `offset=N`（单次最多
  2000 行，可用 `offset` + `limit` 逐段读取任意大小的文件）。

**示例 1 —— 长输出被截断时你看到什么**

跑一次冗长的构建，返回值形如：

```
> build
...（开头 75% 内容）...

[... 41,233 characters omitted from the middle of this output (total 71,233 chars;
head + tail kept). Narrow your query, page with offset/limit, or read the saved
full output if a file path is mentioned below.]

...（结尾 20% 内容，通常含报错行）...
[exit code 1]
[Output truncated: full 71,233 chars saved to C:\Users\you\AppData\Local\Temp\
node-agent-output\bash-1757...txt - read it with read_file offset/limit.]
```

**示例 2 —— 续读被截掉的中间部分**

看到上面的落盘路径后，智能体可以直接：

```json
{ "path": "C:\\Users\\you\\AppData\\Local\\Temp\\node-agent-output\\bash-1757...txt",
  "offset": 150, "limit": 200 }
```

**示例 3 —— 主动要求更小的输出预算**

只需要确认命令是否成功、不需要全部日志时，传 `max_output`（下限 1,000）：

```json
{ "command": "npm run build", "max_output": 2000 }
```

**示例 4 —— 大文件分页读取**

`read_file` 读 5000 行的文件时返回前 2000 行并提示：

```
[Showing lines 1-2000 of 5000 total. Continue with offset=2000 (or raise limit, max 2000).]
```

按提示传 `{"offset": 2000}` 继续读下一段即可。

## 使用

```bash
agent                         # 交互式 UI
agent -p "explain this repo"  # 单轮 print 模式
agent --resume <id>           # 继续一个已保存的会话
agent --model openai:gpt-4o   # 启动时指定模型
agent --auto                  # 自动批准非高危写操作
agent --yolo                  # 批准一切（谨慎使用）
agent --plan                  # 以 Plan 模式启动（先只读探索 + 出计划待批准）
agent --mcp-server            # 作为 MCP 服务器在 stdio 上运行（供其他代理编排）
agent --no-mcp                # 跳过 MCP 服务器
```

### 交互快捷键

| 按键 | 作用 |
| --- | --- |
| `Enter` | 提交提示词 |
| `Esc` | 中断当前轮 / 拒绝确认；空闲时打开历史提示词选择器 |
| `Ctrl+C` | 中断；空闲时退出 |
| `Ctrl+V` | 附加剪贴板中的图片 |
| `Ctrl+O` | 展开 / 折叠所有长回复（超过 14 行的助手消息默认折叠） |
| `↑` / `↓` / `Enter` | 历史选择器中：移动 / 把选中提示词填入输入框 |
| `PageUp` / `PageDown` | 权限确认弹窗中翻页 diff 预览 |
| `y` / `a` / `d` / `n` | 允许一次 / 总是允许 / 总是拒绝 / 拒绝一次（权限确认时） |

### 斜杠命令

`/help` · `/model [spec|list]` · `/auto [on|off]` · `/yolo` · `/plan [on|off]` ·
`/mcp` · `/lsp` · `/compact` · `/review [base] [focus]` ·
`/permissions [clear]` · `/hooks` · `/sessions` · `/resume <id>` · `/todos` · `/undo [-y]` ·
`/cost [usd]` · `/clear` · `/quit`

### Plan 模式（先计划，后执行）

```text
/plan          ← 切换；/plan on / /plan off 显式设置；agent --plan 启动即开启
```

Plan 模式下智能体只拿到只读工具加一个 `exit_plan`：它先用探索工具读代码，然后调用
`exit_plan` 把完整计划（目标、按文件列出的步骤、风险、验证方式）作为确认预览展示给你。
批准 → 切回普通模式立即开工；拒绝 → 留在 Plan 模式继续修订。`runTool` 层还有硬防线：
即使模型幻觉出写工具调用也会被拒绝。worker 子智能体在 Plan 模式下同样被禁止。

### 代码审查（/review）

```text
/review              ← 审查未提交的改动（staged + unstaged + 小的未跟踪文件）
/review main         ← 审查 main...HEAD 区间的改动
/review main 并发安全  ← 附带审查重点
```

diff 超过约 6 万字符会截断；审查只读，不碰工作区。

### 多文件批量编辑（multi_edit）

重命名符号、迁移 import 路径这类跨文件改动：

```json
{ "pattern": "src/**/*.ts", "search": "oldName", "replacement": "newName", "dry_run": true }
```

先用 `dry_run` 预览命中，正式执行时展示合并 diff、只确认一次，每个被改文件自动快照可
`/undo`。`use_regex: true` 支持正则与 `$1` 分组替换。

### 撤销文件修改（/undo）

`write_file` / `edit_file` 在用户批准后会先把目标文件的当前内容快照到
`~/.node-agent/checkpoints/<session>/`（最多保留 50 份），再执行写入。搞砸了：

```text
/undo        ← 查看最近一次改动是哪个文件，不执行
/undo -y     ← 回滚最近一次改动；可连续执行逐次回滚
```

- 被修改的文件 → 恢复改动前内容；代理新建的文件 → 删除它
- 每条快照只能撤销一次——撤销后你再手改文件，不会被下一次 `/undo` 覆盖
- 跨进程有效：快照索引持久化，`/resume` 后仍可撤销本次会话早期的改动
- 快照失败从不阻塞实际写入（尽力而为）；有 git 时它仍是首选回滚手段

### 后台任务（run_in_background）

dev server、watch 构建等长驻命令不该阻塞工具调用或撞超时：

```json
{ "command": "npm run dev", "run_in_background": true }
```

立即返回任务 id（如 `bg1`），进程跨轮次存活，输出直接流到日志文件。之后：

- `bash_output {id: "bg1", since: 0}` — 增量拉取新输出（用上次返回的
  `[next_offset=N]` 作为下次的 `since`），并报告运行中 / 已退出（含退出码）
- `bash_kill {id: "bg1"}` — 终止任务及其整个进程树（需确认）

### 成本与预算（/cost）

```text
/cost          ← 会话累计：总额、token 数、按模型明细（含缓存读写命中）
/cost 5        ← 把本会话预算设为 $5（80% 时告警，耗尽时停止当轮）
```

启动时设 `AGENT_BUDGET_USD=5` 同样生效。价格表覆盖 Claude / GPT / DeepSeek 常见
模型；未知模型只统计 token、不猜美元数。预算耗尽时智能体干净收尾（给未执行的
工具调用回填错误结果），下一条消息可继续或先 `/cost` 调高预算。子智能体与上下文
压缩的 API 调用同样计入总额。

### `@file` 引用

在提示词任意位置输入 `@path/to/file`，文件内容会以
`<file path="…">…</file>` 块的形式内联进来（仅限工作区内路径，总预算约 200 KB）。

### 自定义斜杠命令

把 markdown 文件放进 `~/.node-agent/commands/`（全局）或 `.node-agent/commands/`（项目级），
文件名即命令名。正文是提示词模板，支持 `$ARGUMENTS` 或 `$1`…`$9` 占位符，可选一行
`description:` front-matter：

```markdown
---
description: review a file for bugs
---
Review @$1 for correctness issues. Focus on edge cases.
```

用 `/review src/foo.ts` 调用。

### 钩子（Hooks）

`~/.node-agent/hooks.json`（全局）与 `.node-agent/hooks.json`（项目级）：

```json
{
  "PreToolUse": [
    { "matcher": "bash", "command": "node scripts/guard.js", "timeout": 5000 }
  ],
  "PostToolUse": [
    { "matcher": "edit_file,write_file", "command": "npx prettier --write ..." }
  ]
}
```

每个钩子通过 stdin 收到一个 JSON payload。退出码 `2` 阻断该操作（stderr 作为原因），
其他非零退出码以警告形式呈现，退出码 `0` 的 stdout 会作为额外上下文注入。`matcher`
是以逗号分隔的工具列表或正则；省略则匹配所有工具。

### LSP 诊断

`write_file` 和 `edit_file` 的结果会携带一个 `<diagnostics>` 块，来自语言服务器对刚被
修改文件的诊断（`get_diagnostics` 则可以在不编辑的情况下检查某个文件）。服务器在首次
遇到受支持的文件时惰性启动，并在整个会话中保持热态。默认覆盖 TypeScript/JavaScript
（`typescript-language-server`）和 Python（`pyright`）；在 `~/.node-agent/lsp.json`
（全局）或 `.node-agent/lsp.json`（项目级）中添加或覆盖服务器：

```json
{
  ".go": { "command": "gopls", "args": ["serve"], "timeout": 15000 }
}
```

`timeout` 限制修改后等待服务器发布诊断的最长时间（默认 10 秒）。服务器缺失或损坏绝不
会让编辑失败——只是省略诊断块。`agent --no-lsp` 完全禁用该层，`/lsp` 查看运行中的服务器。

### MCP 服务器

`~/.node-agent/mcp.json` 或 `<cwd>/.mcp.json`：

```json
{
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
  }
}
```

远端工具以 `mcp__<server>__<tool>` 命名空间注册；用 `/mcp` 查看状态。

### mojo 作为 MCP 服务器（`--mcp-server`）

反向也支持：`agent --mcp-server` 在 stdio 上把 mojo 自身暴露为 MCP server，供其他代理
（Claude Code、Cursor 等）编排调用。

```json
{
  "mcpServers": {
    "mojo": { "command": "agent", "args": ["--mcp-server"] }
  }
}
```

暴露的能力：

- 全部只读工具（`read_file` / `grep` / `glob_files` / `web_search` / `git_status` …）
- `agent_chat`：跑一整轮 mojo 智能体循环并返回最终文本。默认无头运行——写/危险操作
  自动拒绝（没人可以批准），因此表现为一个强力的只读分析代理；显式传 `yolo: true`
  才允许它真正修改文件。响应首行的 `[mojo session <id>]` 可作为 `session_id` 传回，
  延续同一段对话
- 资源：`AGENTS.md` / `CLAUDE.md` / `.node-agent/memory.md`，让编排方能直接读到
  智能体的项目指令与长期记忆

协议走 stdout，所有日志走 stderr。

### 子智能体

`task` 工具派生拥有全新上下文的子智能体，两种模式：

- `research`（默认）：只读探索——找定义、追流程、调研模块，可并行开多个
- `worker`：可编辑文件、跑命令，用于实现边界清晰的任务（修一个模块、补测试），
  支撑并行改多个模块。启动前向用户确认一次，其后的每次写/命令仍逐条走正常审批；
  Plan 模式下不可用

## 开发

```bash
npm run dev      # 用 tsx 直接从源码运行
npm run build    # tsc -> dist/
npm test         # vitest run
npm run test:watch
```

测试覆盖：token 统计、智能体调度/钩子集成/成本预算/Plan 模式、上下文压缩（预剪枝 +
增量摘要合并）、自动记忆注入、`/review` diff 收集与提示词、跨文件批量编辑、Web 工具
HTML 解析、钩子运行器、斜杠命令渲染、`@file` 展开、会话持久化、宽容的 `edit_file`
匹配与 diff 生成、文件快照与撤销、Git 工作流护栏、Windows shell 选择与跨 shell 危险
模式、后台任务、分层配置合并、成本核算、输出截断、MCP server（内存传输端到端），以及
LSP 客户端（针对一个假的 language server）。
