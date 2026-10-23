# 常驻 Node REPL（批次 34）

状态：已实现（2026-10-23）｜来源：ZCode 对标 survey 第 3 轮 #13

## 背景与范围

数据探索、增量计算这类任务此前只能在 `bash` 里反复写一次性脚本：每个脚本都要重新载入文件、重建中间结果，既慢又难维护。ZCode 的常驻 REPL 让模型像人用 REPL 一样“加载一次，持续计算”。本批次移植该能力，但把执行体放在**独立子进程**中（ZCode 用进程内 vm），使死循环、`process.exit()`、崩溃都不会拖垮 agent 主进程，且超时可以直接杀进程。

工具名：`node_repl`；只对主 agent 可见（research/worker 子代理的工具集不含它）。

## 架构

```
Agent tool call
  └─ node_repl.execute({code})
       ├─ 高风险审批（description 固定 + code 预览）
       ├─ kernels: Map<sessionId, NodeReplKernel>
       └─ child: node -e <worker>   (cwd = 工作目录)
            stdin  ← {"id":n,"code":"..."} 每行一条
            stdout → 日志行 + "\u0001NODE_REPL:<token>:<json>" 结果行
            stderr → 日志
```

- **每会话一个内核**：键为 `session:${ctx.sessionId}`；无会话 id 时退回 `cwd:<cwd>`。同一内核的调用串行排队（共享一个全局作用域，不能并发）。
- **持久化**：worker 用 `vm.runInThisContext` 执行代码，顶层 `const/let/var/function/class` 留在全局词法环境，跨调用可见；`globalThis.*` 同样保留。`require` 通过 `createRequire(cwd + "/")` 注入，`await import(...)` 可用。
- **结果语义**：脚本的 completion value 即最后一条表达式的值（和 Node REPL 一致）；返回 Promise 时自动 await。`undefined` 不输出结果行。
- **顶层 await**：先尝试按普通脚本编译；若报 “only valid in async functions”，先尝试单表达式包装 `(async () => (code))()`（保留返回值），再退回语句包装 `(async () => { code })()`。后者的声明不会跨调用保留，需要持久化时请写 `globalThis.x = ...`。
- **协议防污染**：每个内核随机生成 token，结果行以 `\u0001NODE_REPL:<token>:` 开头并独占一行；其余 stdout 行一律视为程序日志。worker 在结果行前补一个换行，避免无换行输出粘连。

## 输出与错误

- 成功：`日志...` + `\n\n=> <util.inspect(value)>`；仅日志或仅结果均可；都没有时返回 `(no output)`。stderr 以 `[stderr]` 段附后。
- 代码抛错：`Error: message` + 过滤掉 `node:internal`/`node_repl.js` 帧后的至多 8 行栈；`isError: true`，内核与已有绑定继续可用。
- `unhandledRejection` / `uncaughtException` 被 worker 捕获并写入 stderr，不让内核退出。
- 输出预算：默认返回 30000 字符（`max_output` 可调，最低 1000）；超出时由 `boundedResult` 落盘到临时文件并保留 head+tail 指针。运行中 stdout 累计超过 200000 字符则判定为失控输出，杀掉内核并报错（避免无界缓冲）。

## 生命周期

| 事件 | 行为 |
| --- | --- |
| 单次超时 | `timeout_ms`（默认 `AGENT_REPL_TIMEOUT_MS` 或 30s，上限 120s）到点杀进程；报错说明内核已重启、状态丢失 |
| 用户中断 | `ctx.signal` abort → 杀进程；返回 aborted 错误（随后 agent 丢弃本轮结果） |
| 进程崩溃/退出 | 当前请求报错；下一次调用自动重启（新状态） |
| 空闲 | `AGENT_REPL_IDLE_MS`（默认 10 分钟，0 关闭）后 dispose 并移出表；下次调用新建内核 |
| 会话切换 | `Agent.resetSession()`（/clear、/resume、/fork、GUI 项目切换）先 dispose 旧会话内核 |
| 进程退出 | 模块级 `exit` 钩子杀光所有内核；POSIX 子进程独立进程组，`killTree` 整组终止 |

内核**不随上下文压缩重置**：vm 状态在独立进程中，压缩只影响消息历史，因此压缩后变量仍在。但 agent 无法感知压缩前后模型是否还记得这些变量，系统提示会提示“重启后需重建”。

## 权限与安全

- `isReadOnly: false`，因此计划模式会直接拦截（`agent.runTool` 的 plan-mode 分支）。
- 每次内核首次执行都要经过 `askPermission`，风险级别 **high**，预览展示代码（最多 4000 字符）。description 固定为 “Run JavaScript in the persistent Node REPL (arbitrary code execution in this workspace)”，所以用户选 session/project/always 授权后，本工作区内后续调用不再逐条询问；预览仍逐次展示代码。
- 这是**任意代码执行**，与 bash 同级信任：内核继承进程环境变量、可读写工作区。没有 vm 沙箱（vm 不是安全边界，隔离靠独立进程）。
- 工具不参与并行波次（`parallelSafe` 未设置），变更类调度独占执行。
- research/worker 子代理的工具集不包含 `node_repl`，避免子代理绕过主 agent 的审批语义。

## 系统提示

仅在 `node_repl` 出现在当前工具列表时注入一段指导：优先用于需要跨调用保留状态的 JavaScript/数据工作；shell 命令仍用 bash；后台服务用 `bash run_in_background`；内核重启后需重建昂贵状态。计划模式下该工具不在列表，指导也不会出现。

## 测试

`tests/nodeRepl.test.ts`（14，真实子进程）：
- 顶层 `const`/`let` 跨调用与变更保留；并发调用串行化；`require` 可用。
- 日志 + 结果合并；抛错后绑定仍在。
- 顶层 await 单表达式返回值；多语句 async 通过 `globalThis` 持久化。
- 会话隔离；`disposeNodeReplSession` 清空状态；空闲超时后新内核。
- 超时/中断后内核重启且状态丢失；拒绝审批时不执行（断言 high + code 预览）。
- 超大输出截断并给出完整文件指针。

`tests/prompts.test.ts`：node_repl 指导块按工具门控出现。

## 刻意不做

- 不做解析器级的声明提升（ZCode 用 meriyah 把每个顶层声明挂到 `globalThis`，从而支持多语句顶层 await 的持久化）；本实现不为一个 REPL 引入运行时依赖，改用“单表达式 await 保留值、多语句写 globalThis”的约定。
- 不做图片/二进制结果回传（ZCode 支持截图 image block）；数据结果以文本为准。
- 不提供交互式 stdin、`.editor`、自动补全；stdin 专用于协议。
- 不做内核状态持久化到磁盘（进程退出即丢失），也不跨会话共享内核。
