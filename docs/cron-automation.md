# 定时任务（cron）

## 状态

- 2026-10-22 落地。本文是定时 agent 任务的规范：表达式、持久化、单所有者调度、
  无头执行与 GUI / 命令入口。

## 任务模型与存储

- 台账是全局文件 `~/.node-agent/cron.json`（0600，临时文件 + rename 原子写入），
  任何 agent 进程都可以编辑；最多 50 条。
- 单条任务：`id`（`cr_` + 8 位 hex）、`name`、5 段 `cron`、`prompt`、绝对路径 `cwd`、
  `enabled`、`createdAt`、`nextRunAt`、`runCount`，以及最近一次运行的
  `lastRunAt` / `lastStatus`（`ok` | `error` | `running`）/ `lastError` / `lastLog` /
  `runStartedAt`。
- `name` 留空时取提示词前 40 个字符；提示词上限 8000 字符；`cwd` 必须是绝对路径，且创建
  任务或修改 `cwd` 时必须存在且为目录（仅切换启用状态不重新校验）。
- 运行日志写入 `~/.node-agent/cron-runs/<id>-<ISO 时间戳>.log`（目录 0700，文件 0600），
  开头记录任务、表达式、目录与提示词，结尾记录退出码；日志不可写只影响记录，不会中断运行
  或拖垮调度进程。
- 台账损坏（非法 JSON / 缺 `tasks` 数组）时读取报错但绝不覆盖原文件；单条损坏的任务被跳过。

## 表达式

经典 5 段形式，按**本机时区**解释：

```text
minute hour day-of-month month day-of-week
0 9 * * 1-5        # 工作日 09:00
30 23 * * *        # 每天 23:30
*/15 * * * *       # 每 15 分钟
0 18 1 * *         # 每月 1 日 18:00
```

- 字段支持 `*`、单值 `a`、区间 `a-b`、带步长 `a-b/n`、`*/n`、`a/n`（从 a 到字段上限），
  以及逗号列表；日/月/星期按各自范围校验（如 `61 9 * * *` 报 minute 越界）。
- 星期接受 0-7，0 与 7 都表示周日；不支持 `MON` / `JAN` 之类的名字。
- 日与星期**同时受限**时采用经典 OR 语义（任一匹配即触发）。
- `nextRunAt` 从当前时刻**严格向后**逐日搜索（上限约 12 年），能正确跨月、跨年与
  2 月 29 日；永远不可能触发的表达式（如 `0 0 31 2 *`）在保存时报错。
- 停用再启用、或修改表达式后，都会按新表达式重算 `nextRunAt`。

## 调度器：单所有者 + 待命

- 调度器随交互式 CLI 与 GUI 后端启动；`--no-cron` 关闭调度器（任务仍可编辑）。
- 所有进程通过 `~/.node-agent/cron-scheduler.json` 的租约竞争唯一所有者。租约以 `O_EXCL`
  原子创建，记录 pid 与每个调度器实例独有的 token；同时启动时只有一个进程能创建成功，
  同一进程内的第二个实例也只会待命。持有者退出后 pid 失效，其他进程在下一轮轮询中清理
  旧租约并接管；停机时只删除 token 匹配的租约。
- 默认每 30 秒轮询一次，可用 `AGENT_CRON_TICK_MS`（≥1000）调整。待命进程仍可立即运行任务。
- 到期任务在**执行前**先把 `nextRunAt` 推进到下一个槽位并标记 `running`，因此进程崩溃
  不会在同一槽位重复触发。表达式已损坏或 `nextRunAt` 无法解析的任务会被停用并写入错误，
  避免静默地永不触发。
- 调度器进程内同一时刻只执行一个任务（串行队列），同一任务不会在同一进程内并发执行；
  不同进程的手工“立即运行”彼此独立（台账仍会把任务标记为 `running`）。
- 启动时把超过 2 小时仍处于 `running` 的任务标为失败（`run interrupted ...`），覆盖被
  强杀、来不及写回状态的情形。
- 手工 “立即运行” 不改变 `nextRunAt`，只更新最近运行信息与计数。

## 定时运行 = 新开无头 agent 会话

- 每次触发都以任务的 `cwd` 为目录、重新拉起当前 CLI：
  `node <cli> -p <prompt> --auto --no-lsp`，因此使用与普通 agent 相同的工具、权限与模型。
- 子进程环境注入 `AGENT_CRON_RUN=<id>`、`AGENT_CRON_TASK=<name>`、`AGENT_NO_CRON=1`。
- 单次运行默认 30 分钟超时（`AGENT_CRON_TIMEOUT_MS`），超时/取消时杀掉整棵进程树
  （Windows `taskkill /T /F`，POSIX 进程组 SIGKILL）。
- 非零退出码把 stderr 末尾 5 行写入 `lastError`；成功只记录日志路径。
- print 模式的 stdin 不是 TTY 时，权限确认自动拒绝而**不是**挂起等待输入——无人值守运行
  不会卡死；需要写操作时请通过 `--auto` 覆盖的规则或权限配置提前放行。

## 递归防护

- 定时运行内部（`AGENT_CRON_RUN` 存在时）禁止 `cron_create` 与 `cron_delete`，`cron_list`
  仍然可用；子进程也不会启动调度器（`AGENT_NO_CRON=1`）。这防止一次运行创建出不断
  自我复制的任务链。

## 入口

### GUI

- 侧栏 `⚙` → 「定时任务」标签：列表展示状态点、表达式徽章、运行中/已暂停/上次失败标记、
  下次运行、已运行次数、工作目录、上次结果与错误；可添加、编辑、暂停/启用、立即运行、删除。
- 顶部说明会区分：`--no-cron`、调度器未运行、本进程持有调度器、本进程待命（另一个 agent
  持有）。
- 后端接口：`GET /api/cron`；`POST /api/cron/save`（有 `id` 为编辑）、`/api/cron/delete`、
  `/api/cron/toggle`、`/api/cron/run`。每次变更广播 SSE `cron_changed`，打开中的面板自动刷新。
- GUI 中“运行”是异步入队：接口立即返回，完成后由 `cron_changed` 刷新状态。

### 命令与工具

- `/cron` 列出全部任务；`/cron add <min> <hour> <day> <month> <weekday> <prompt>` 创建
  （目录取当前会话的 cwd）；`/cron on|off|run|rm <id>` 管理任务。
- agent 工具：`cron_create`（高危审批）、`cron_list`（只读）、`cron_delete`（高危审批）。
- `agent --no-cron`：交互式 CLI 与 GUI 都不启动调度器。

## 代码与测试

- `src/cron.ts`：表达式解析、下一次触发时间、台账读写、领取/启动/结束/陈旧恢复。
- `src/cronScheduler.ts`：租约、轮询、串行执行、进程拉起与超时终止。
- `src/tools/cron.ts`：agent 侧创建/列出/删除工具与递归防护。
- `src/agentCommands.ts`：`/cron` 子命令。
- `src/gui/server.ts` / `src/gui/backend.ts` / `src/gui/static/app.js`：REST、SSE 与管理界面。
- 测试：`tests/cron.test.ts`（解析/存储/领取/恢复）、`tests/cronScheduler.test.ts`
  （租约/执行/进程运行器/超时）、`tests/cronTools.test.ts`（审批与递归防护）、
  `tests/guiServer.test.ts` 与 `tests/guiDom.test.ts`（接口与界面）。
