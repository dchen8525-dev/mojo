# 取消流持久化 + Windows shell 快照

状态：2026-10-22 批次（ZCode 调研候选中两个 S 项）

## 一、取消流持久化（cancelled-stream persistence）

ZCode 参考：`packages/core/src/runtime/methods/cancelled-stream-persistence.ts`。

### 行为

- 用户在流式响应中途停止（Ctrl+C / GUI 停止按钮）时，已流出到界面的部分文本不再丢失：
  1. `LLM.sendResumable` 现在全程跟踪已向调用方发出的文本增量（`streamed`）；
  2. 中止时不再抛普通 `Error("aborted")`，而是抛 `CancelledStreamError`（message 仍为 `"aborted"`，既有调用方的字符串匹配不受影响），携带 `partialText`；
  3. `Agent.chat` 捕获后将部分文本作为**纯 assistant 文本消息**追加进历史并立即持久化会话，然后继续向上抛中止错误。
- 效果：`/resume` 或 GUI 重新打开会话后，用户看到与停止时界面一致的内容；历史保持 API 有效（纯文本 assistant 消息不需要配对 tool_result）。
- 恢复尝试（resume）期间中止：Anthropic（原生 prefill）用 `partial + resumedDelta`（严格接续），OpenAI 只用已捕获的 `partial`（续写可能回吐重叠文本，宁缺勿重）。
- 空部分文本不追加任何消息；补救持久化本身失败也是 best-effort，原始中止错误照常传播。
- 持久化逻辑抽成 `Agent.persistTurn()`（正常结束与补救共用同一 append/rewrite + model-spec 记账）。

### 涉及文件

- `src/llm/types.ts`：新增 `CancelledStreamError`。
- `src/llm.ts`：`sendResumable` 增量跟踪 + 中止路径改抛 `CancelledStreamError`；导出该类。
- `src/agent.ts`：chat 的 catch 补救分支 + `persistTurn()` 提取。

### 测试

- `tests/llmCancel.test.ts`（3 项）：中途中止携带已流出文本；无输出时为空串；Anthropic resume 期间中止 = prefill + 暂存后缀。
- `tests/agent.test.ts`（+1 项）：中止后历史含部分文本 assistant 消息且会话 mock 收到追加；空部分不追加。

## 二、Windows shell 快照（shell snapshot）

ZCode 参考：`apps/zcode-cli/packages/adapters/src/exec/shell-init-snapshot.ts`（POSIX 方案）；mojo 的缺口在 Windows——bash 工具用 `-NoProfile` 启动 PowerShell，用户 profile 里的 PATH 扩展（vcpkg、gh 等）和环境变量被静默丢弃；GUI/cron 拉起的进程继承得更少。POSIX 不需要：bash 工具本就以 `-lc` 登录 shell 运行，每次命令都加载 profile。

### 行为

- 首次 bash 调用（前台或后台任务）时，用解析出的 PowerShell（与 bash 工具 `pickWin32Shell` 同一套解析：AGENT_SHELL > COMSPEC）以 `-NoProfile -NonInteractive` 启动一次性进程：
  - 先记录当前进程环境基线；
  - 依序 dot-source 四个 `$PROFILE` 脚本（AllUsersAllHosts / AllUsersCurrentHost / CurrentUserAllHosts / CurrentUserCurrentHost，存在才加载，错误静默）；
  - 输出 profile 改动/新增的环境变量（仅差量，JSON）。
- 10s 超时、1MB 输出上限，失败返回 null（静默降级，绝不影响命令执行）。
- 差量合并进 spawn env（`mergeShellSnapshotEnv`）：
  - `PATH`：采快照值（基线 PATH + profile 追加的超集），写回时沿用 base 已有的大小写，避免出现两个 PATH 键；
  - 其余变量：仅补缺失或空值，agent 自身环境永远优先。
- 快照**只在内存**按 shell exe 缓存（每进程一次）——profile 环境可能含敏感值，不落盘。`AGENT_SHELL_SNAPSHOT=0` 整体关闭；cmd.exe 无 profile 概念，自动跳过。

### 涉及文件

- `src/shellSnapshot.ts`（新增）：解析/采集/缓存/合并。
- `src/tools/bash.ts`：前台 spawn env 合并（readOnlyBashTool 复用同路径）。
- `src/tools/background.ts`：后台任务 spawn env 合并。

### 测试

`tests/shellSnapshot.test.ts`（10 项）：shell 解析（含 AGENT_SHELL=cmd 显式关闭）；JSON 解析与脏输出；合并规则（PATH 覆盖、其余补缺、大小写归一）；开关门控；Windows 真机实测（真实 powershell.exe 采集 + 进程内缓存命中）。

## 验证

lint + build 干净；全量 69 文件 / 876 通过 / 6 跳过（含 Windows 真机 PowerShell 采集实测）。
