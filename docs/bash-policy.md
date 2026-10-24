# bash 工具策略（只读分类 / 分级超时 / 子代理只读 shell）

## 状态

- 2026-10-21 落地（a3ca3e4 只读分类；3395af1 分级超时与子代理只读 shell）。

## 只读分类（`isReadOnlyCommand`）

- 保守单命令白名单：git 只读子命令（status/log/diff/show/blame/rev-parse/ls-files/reflog/cat-file/grep/whatchanged；`config` 仅 `--get/--list`），以及 ls/cat/head/tail/findstr 等单程序。
- 任一复合（`|;&`）、重定向（`<>`）、替换（`$(`、反引号、换行）或危险模式（`isDangerousCommand`）→ 整体不算只读。
- 只读命令跳过权限提示直接执行；bash 工具本身 `isReadOnly: false`。

## 危险模式（恒为 high risk）

- `isDangerousCommand` 命中的命令即使 auto（accept edits）模式也必须人工审批；描述行追加
  `[matches a dangerous pattern]`。
- 删除/提权/外传类：`rm`（带 `-r/-f`）、`del/erase`、`Remove-Item`、`taskkill`、`sudo`、
  `chmod/chown`、`icacls`，以及 Windows 树删除（`rd /s`、`robocopy /MIR|/PURGE`，含
  `cmd /c`、PowerShell、绝对路径包装）。
- git 丢弃未提交工作或删除工作区文件：`push --force`、`reset --hard`、`clean -`、
  `checkout -- <path>` / `checkout .` / `checkout -f|--force`、`switch -f|--force|--discard-changes`、
  `restore`（仅 `--staged` / `-S` 的纯取消暂存放行；`--worktree` / `-W` / `--source` / `-s`
  一律危险，短选项区分大小写）、`stash drop|clear`、`git rm`（`--cached` 只取消暂存，放行）。
  普通分支切换（`checkout <branch>`、`checkout -b`、`switch <branch>`）不在此列。

## 分级默认超时（`defaultTimeoutMs`）

| 命令类别 | 默认 |
| --- | --- |
| 只读命令 | 30s |
| 构建/测试类（npm/pnpm/yarn/npx/tsc/vite/webpack/make/cmake/cargo/gradle/mvn/pytest/go/dotnet） | 300s |
| 其余 | 120s |

- 调用方显式 `timeout_ms` 永远优先；硬上限 600s，输出硬上限 200KB（超出即 kill，全文落盘，见
  [tool-result-artifacts.md](tool-result-artifacts.md)）。

## 子代理只读 shell（`readOnlyBashTool`）

- task 工具 research 模式的 bash 包装：research 模式自动放行权限，因此只读分类在这里是**硬门禁**——
  未分类为只读的命令在 spawn 之前直接拒绝，不依赖提示。
- 暴露给研究子代理的目的是让它们能跑 `git log/diff/status` 等命令获取 shell 可见事实。

## 代码

- `src/tools/bash.ts`；测试：`tests/bash.test.ts`。
