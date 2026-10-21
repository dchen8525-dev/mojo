# 工作区 hook 信任

## 状态

- 2026-10-21 落地（60da2c7）。本文是项目级 hooks 信任模型的事实规范。

## 模型

- 项目 `.node-agent/hooks.json` 来自仓库、可执行任意本地命令，**默认不信任、不加载**（fail closed）。
- 信任记录存于 `~/.node-agent/hook-trust.json`，键 = 归一化工作区路径（win32 小写）+ hook 文件字节的
  SHA-256 摘要。全局 `~/.node-agent/hooks.json` 始终受信，不经过此流程。

## 行为

- `/hooks trust` 对当前工作区的该文件版本建立信任；`/hooks revoke` 撤销（幂等）。
- 文件任何改动（含 matcher/命令语义变化）使摘要失配，自动回到未信任，需重新批准。
- 未信任时启动打警告（CLI console + GUI），`/hooks` 列表追加 ⚠ 未加载提示；`HookManager.load()` 幂等：
  每次调用先重置再按信任状态装载。

## 代码

- `src/hooks.ts`（trust store / digest / revoke）；`src/agentCommands.ts`、`src/cli.ts`、`src/gui/backend.ts`（界面）。
- 测试：`tests/hooks.test.ts`（workspace hook trust 用例）。
