# SSE 回放夹具：GUI 事件契约的漂移检测与端到端回放

日期：2026-10-22 · 测试：`tests/guiSseReplay.test.ts` · 夹具：`tests/fixtures/sse/*.jsonl`

## 动机

GUI 的服务端→客户端事件流（`/api/events` SSE）是前后端之间最重要的隐式契约：payload 字段
名、事件顺序、生命周期配对（`turn_start`…`turn_end`）一旦漂移，前端的实时流、工具卡片、
权限弹窗都会静默坏掉。现有测试要么 mock 每一层（`guiDom`），要么只断言个别事件
（`guiRetryE2E`），没有一个把**完整事件序列**钉住的地方。

## 设计

一个测试文件、两半：

1. **捕获 + 漂移检测（真实后端）**。`startGuiBackend` 起**真实** GUI 后端（无 MCP/LSP/cron），
   打到脚本化的 mock Anthropic 端点（`scripts[]` 按请求序号回放 `message_start →
   content_block_* → message_delta → message_stop` 完整序列，含 `tool_use` +
   `input_json_delta`）。两个黄金场景：
   - `golden-turn`：流式文本 → `read_file` 工具一轮 → 第二轮最终文本；
   - `permission-diff`：`write_file` → `permission_request`（含 `@@` diff 预览）→
     `POST /api/permission {id, decision:"yes"}` → 工具完成。
   订阅真实 SSE 流，过滤为回合契约事件白名单，按 `turn_start`…`turn_end` 截取，**规范化**
   易变值（临时目录 → `<PROJECT>`/`<HOME>`，UUID → `<UUID>`），与入库夹具逐行比对。任何
   payload/顺序漂移在此失败，而不是在前端静默坏掉。
   `AGENT_SSE_CAPTURE=1 npx vitest run tests/guiSseReplay.test.ts` 重新生成夹具。

2. **happy-dom 回放**。把规范化夹具逐帧 `emit()` 进 happy-dom 里真实 `app.js` 注册的
   SSE 处理器，断言 UI 结果：流式文本气泡、工具卡片 ✓ 状态、权限弹窗的风险徽章/描述/
   结构化 diff、批准按钮发出的 `{id, decision}` POST、`turn_end` 后 composer 解锁。
   `turn_end` 会触发 `refreshState()` 全量重绘（真实服务器此时用会话历史重建 transcript），
   测试因此先设置 mock `/api/state` 的 `transcript` 再发 `turn_end`，与真实行为一致。

## 夹具内容（golden-turn.jsonl 摘录）

```
turn_start {turnId,user,images} → round_start → text_delta → tool_use_start{name,id,round}
→ usage → tool_start{id,name,inputPreview,input} → tool_end{id,name,ok,preview,result}
→ round_start → text_delta → usage → turn_end{turnId,text}
```

注意真实顺序：`usage` 在 `tool_use_start` 之后到达（agent 在跑工具前广播用量之后才排序
进 SSE），夹具钉住的就是这个顺序；新增事件或改字段名都会使比对失败。

## 已知边界

- 白名单外的启动期广播（`model_meta`、`project_changed` 等）不属于回合契约，不捕获。
- 回放侧假定夹具帧与 UI 处理器一一对应；它验证**消费者**，捕获侧验证**生产者**，合起来
  才是完整契约。
- `renderSegment` 走 `requestAnimationFrame`，回放断言文本气泡时用 `vi.waitFor` 轮询。
