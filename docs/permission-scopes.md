# 权限答案的作用域

## 状态

- 2026-10-21 落地（594bbfe）。本文是权限提示答案语义的规范。

## 答案选项

| 键 | 语义 |
| --- | --- |
| `y` / yes | 只放行本次调用（allow_once） |
| `s` / session | 进程内记忆授权，重启失效 |
| `p` / project | 持久化到 `<cwd>/.node-agent/permissions.json`，仅本仓库生效 |
| `a` / always | 持久化到全局配置，所有仓库生效 |
| `d` / deny (always_deny) | 永久拒绝该模式 |
| `n` / no | 仅拒绝本次 |

## 优先级

1. `always_deny` 规则（始终最高，含子代理场景）。
2. 持久化 allow 规则（project/always，按规则模式匹配）。
3. session 内存授权。
4. 都未命中 → 弹提示。

- 只读工具（`isReadOnly: true`）默认放行，不弹提示；bash 的逐命令分类见
  [bash-policy.md](bash-policy.md)。
- 并行子代理同时请求权限时串行化提问，避免提示槽位互相覆盖。

## 代码

- `src/permissions.ts`；GUI 规则管理在 `src/gui/`。
- 测试：`tests/permissions.test.ts`。
