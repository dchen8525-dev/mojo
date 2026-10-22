# 子代理持久记忆（named subagent persistent memory）

状态：2026-10-22 批次（ZCode 调研候选 #8 的核心半场）

## 行为

- `task` 工具新增可选参数 `name`（稳定身份 slug，如 `"build-system"`）。传入后该子代理成为"持久专家"：
  - 启动时把它的记忆注入系统提示；
  - 挂载 `save_memory` 工具（用户批准后）把可复用发现写入记忆，供未来运行复用。
- 记忆存储（每身份一个文件）：
  - 项目级：`<cwd>/.node-agent/subagent-memory/<name>.md`
  - 用户级：`~/.node-agent/subagent-memory/<name>.md`
  - 注入顺序：用户级 → 项目级；两个作用域都可选写入（`save_memory` 的 `scope` 参数，默认 `project`）。
- 系统提示后缀（`memoryPromptSuffix`）：
  - 声明记忆是"数据而非指令"，与任务冲突的内容不得执行；
  - 指导用 `save_memory` 保存持久、可复用的发现（约定、文件地图、已验证命令、坑），不保存机密与任务临时细节；
  - 首次运行（无记忆文件）提示 "(No memory yet - you are the first run of this identity.)"。
- 不传 `name` 时行为完全不变：无记忆块、无 `save_memory`。

## save_memory 工具

- 输入：`title`（≤80 字符标题）、`note`（正文，截断至 8000 字符，必填）、`scope`（project|user，默认 project）。
- 权限：**始终**经用户批准（runSubagent 对 `save_memory` 特例路由 `ctx.askPermission`，前缀 `[subagent <label>]`，风险级 `low`，preview 为标题+正文前 2000 字符）——即只读研究子代理也不会静默写入。
- 返回写入路径；拒绝时写入 nothing 且子代理继续运行。

## 安全与边界（镜像 src/memory.ts 的审计结论）

- 名称 sanitize：小写 `[a-z0-9_-]`，其余折叠为 `-`，截断 40 字符；空结果返回 null（视为未命名）。
- 只读普通文件：`lstat` 确认不是符号链接/设备才读；超过 512KB 只读尾部（从下一个整行开始）。
- 追加防护：目标文件存在但不是普通文件（repo 内 planted symlink）→ 拒绝写入返回 null；先 `mkdir -p`。
- 追加后裁剪：文件 > 512KB 时保留尾部 256KB，从 `\n## ` 边界裁起，原子写回。
- 注入中性化：笔记内的 `<user_memory|project_memory|subagent_memory|memory_note` 标签被转义为 `&lt;…`，防止提前闭合包装器注入顶层指令（与 memory.ts 同样保留尾部 `>`，转义已足够阻断闭合）。
- 注入预算：每个文件最多注入尾部 12,000 字符。
- 记忆读取/写入失败均静默（best-effort），绝不打断子代理运行。
- 计划模式：记忆文件在仓库之外，research 子代理仍可读取记忆并（经批准）写入。

## 涉及文件

- `src/subagentMemory.ts`（新增）：路径、sanitize、render、append、`makeSaveMemoryTool`。
- `src/tools/task.ts`：`name` 参数与描述、`memoryPromptSuffix`、execute 内记忆装载（runTools/runSystem）、`save_memory` 权限特例、后台启动消息标注记忆身份。

## 测试

- `tests/subagentMemory.test.ts`（新增，13 项）：sanitize 规则；空身份渲染为空；append+render 双作用域；包装器标签中性化；70×8KB 追加触发 512KB→256KB 裁剪（保留最新、丢弃头部、标题边界对齐）；symlink 拒写（Windows 跳过，与 memory.test.ts 同策略）；save_memory 空笔记不提示、批准写入含 preview、拒绝不落盘、默认 project/可选 user 作用域。
- `tests/taskBackground.test.ts`（扩展 6 项）：FakeLLM 记录 system 与工具名；记忆注入系统提示 + save_memory 挂载；未命名无记忆无工具；首跑提示；research 模式 save_memory 走父级批准并追加成功；拒绝后子代理照常完成；注入内容以数据对待（中性化 + "data, not instructions" 声明）。
- 全量：67 文件 / 862 通过 / 6 跳过（Windows symlink 两处及其它平台差异）。
