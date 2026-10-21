# 工具调用波次调度

## 状态

- 2026-10-21 落地（3395af1）。本文是单轮内工具调用执行顺序的规范。

## 规则

- `planWaves`：按模型发出顺序扫描 tool_use；相邻的 `parallelSafe` 工具并成一波并发执行；遇非
  parallelSafe（有副作用）工具则当前波截断，该工具独立成波。发射顺序始终保留。
- 每波并发上限 `MAX_WAVE_CONCURRENCY = 8`（`runWave` 池化执行）。
- 有副作用的工具永不与任何其他工具重叠；只读工具彼此并发。
- 结果按 tool_use_id 回填，与调用顺序无关。

## 与旧实现的差异

- 旧实现"全部 parallelSafe 先跑、其余串行随后"，破坏发射顺序；波次调度按位置分组，serial 工具之间的
  相对顺序与其前后的并行组都保持原序。

## 代码

- `src/scheduler.ts`；接入点 `src/agent.ts`（chat 工具循环）。
- 测试：`tests/scheduler.test.ts`、`tests/agent.test.ts`（波次调度用例）。
