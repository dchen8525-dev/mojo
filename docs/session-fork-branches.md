# 会话 fork 分支（session fork branches）

- 状态：已实现（2026-10-22）
- 模块：`src/session.ts`（forkSession + SessionMeta.forkPoint）、`src/agent.ts`（fork 使用返回的历史）、
  `src/agentCommands.ts`（/sessions 血缘 + --fork-of）、GUI 侧栏徽标
- 测试：`tests/session.test.ts`（forkSession 4 条）、`tests/agent.test.ts`（Agent.fork 更新）、
  `tests/agentCommands.test.ts`（/sessions 血缘 1 条）

## 动机

mojo 的 `/fork` 早已能"复制前 N 条消息到新会话文件并切过去"，但 fork 出来的会话是
孤儿：模型不知道上文的来历，/sessions 里看不出谁是谁的分支，也没有办法列出某个会话
的所有分支。ZCode 的会话分支是两条机制：跨会话 fork（复制 + `parentID` 血缘 +
model-only 的 fork 通知）与会话内 branch-cut 游标（rewind 用）。mojo 没有会话内
消息回滚（对话 rewind 不在范围内），所以本批次补齐的是 fork 轨的三块缺口。

## 行为

### 1. 元数据血缘

`SessionMeta` 新增 `forkPoint?: number`（fork 时从父会话复制的消息条数，即切点）；
`forkedFrom`（父会话 id）原本就有但只是死数据，现在被消费：

- `/sessions` 行内：fork 会话前缀 `⑂<父id前8位>@<切点> `；有子分支的会话尾部
  ` (+N⑂)`；
- 新过滤器 `--fork-of <id前缀>`：只列出某会话的分支（用于 fork 输出里给出的
  "list this branch" 入口）；
- GUI 侧栏：fork 会话标题前显示 `⑂` 徽标，悬停提示"分叉自 <父id>（继承 N 条消息）"。

### 2. 模型侧 fork 通知

`forkSession` 在子会话文件末尾追加一条 user 消息（仅写入子文件，父文件不动）：

```
<system-reminder event="SessionFork">This session forked from session <id>: the
N message(s) above are inherited verbatim from it. New turns in this session
diverge from the original.</system-reminder>
```

与 RecalledMemory / SubagentMessage 等共用统一的 `<system-reminder>` 通道。无父会话
的普通 fork（理论上不会发生，/fork 总是带 fromId）不追加。

### 3. 持久化对齐

`forkSession` 现在返回实际写入的历史（`{ id, meta, messages }`）；`Agent.fork` 用
这个返回值作为 `resetSession` 的 history，保证 `persisted` 计数与文件内容一致
（此前 agent 只知道自己传进去的 prefix，若文件里多一条通知就会错位）。fork 通知在
下一回合随常规持久化落盘对齐，模型每回合都能看到它的来历。

## 与 ZCode 的差异（有意简化）

- **无会话内 branch-cut**：ZCode 的 `session.revert` 游标（`branchCutAfterMessageID`
  + `keptMessageIDs` + generation）服务于"对话回滚/编辑重发"；mojo 的对话不可
  rewind，分支只通过文件级 fork 产生。
- **无 active-chain 选择器**：单文件单链，无消息树，无需过滤函数。
- **子会话不复制 todos 之外的状态**：ZCode 的 fork 事务还复制 verifier entries /
  goal 等，mojo 只有消息 + todos。

## 兼容性

旧会话文件没有 `forkPoint`，loader 按缺失处理（行内只显示 `⑂<父id前8位>`，无
`@切点`）；`forkedFrom` 指向已删除的会话时徽标/行标记照常显示（id 前缀而已），
`--fork-of` 过滤自然为空。
