# 媒体预算（media budget）

- 状态：已实现（2026-10-22）
- 模块：`src/mediaBudget.ts`、`src/agent.ts`（chat/steer 入口 + 每回合发送前）
- 测试：`tests/mediaBudget.test.ts`（9 条）、`tests/agent.test.ts`（Agent.chat media budget 2 条）

## 动机

图片主导上下文窗口：一张 5 MiB 的 base64 图约折合数千 token，若干张即可把会话推入
压缩区间。ZCode 对入站流量（每条消息/每张图）和驻留历史（全会话）分别设上限，超出
时从最旧开始裁剪。mojo 此前对图片数量与体积完全不设防，多模态工具结果也无处裁剪。

## 三个上限（环境变量可覆盖，非正数回退默认值）

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `AGENT_MAX_IMAGES_PER_MESSAGE` | 5 | 单次 `chat()`/`steer()` 调用接受的图片数 |
| `AGENT_MAX_IMAGE_BYTES` | 5 MiB | 单张图片解码后字节上限（base64 长度 × 3/4，无需真正解码） |
| `AGENT_MAX_SESSION_IMAGES` | 20 | 会话历史中允许驻留的图片总数 |

## 行为

### 入站校验（真边界）

`validateImages(images, limits)` 在 `Agent.chat()` 入口与 `Agent.steer()` 中调用——
这是用户输入进入系统的唯一通道：

- 图片数超限 → 抛 `too many images: N sent, limit X per message (AGENT_MAX_IMAGES_PER_MESSAGE)`
- 单张超限 → 抛 `image too large: ~X MB, limit Y MB (AGENT_MAX_IMAGE_BYTES)`

校验在任何会话落盘或消息追加之前进行；GUI 服务器的 steer 分支捕获校验错误并返回 400，
发送端的错误信息原样可见。

### 驻留裁剪（最旧优先，原地替换）

`enforceSessionMediaBudget(messages, limits)` 在每个模型回合发送前执行（`llm.send`
之前一行）：

1. 统计驻留图片数：用户消息的 `image` 块 **和** `tool_result` 内容里的 `image` 分部；
2. 超出 `sessionImages` 时从最旧开始，把 `{type:"image"}` 原地替换为
   `{type:"text", text:"[image removed: session media budget]"}`（tool_result 内的
   image 分部同理替换），保持 API 结构合法；
3. 返回裁剪数量；调用方在数量 > 0 时必须 `tokens.invalidate()`——锚点覆盖的是
   发送前缀，历史被改写后锚点失效需重新估算。

## 与 autocompact 的关系

`src/tokens.ts` 已对每张图片按 1600 token 计费（images are billed as large blocks），
驻留图片被裁剪后估算随之下降，autocompact 决策层天然感知媒体预算，无需额外改动。

## 设计取舍

- **入站拒绝 vs 静默裁剪**：用户输入是最难回滚的（图片往往在 GUI 端已上传），故
  入站用硬错误让用户立刻知道；驻留历史裁剪无法征求用户意见（发生在回合中途），
  用占位文本保留“这里曾有图”的事实，模型可依据上下文推断。
- **原地替换而非删除**：删除 image 块可能让含图消息变成空 content（API 非法）；
  文本占位永远合法，且对模型是自解释的。
- **tool_result 里的图片同样计入**：多模态工具（截图、读图）是图片进入历史的另一
  条主路，只管用户输入等于没管。
- **暂不持久化裁剪到会话文件**：裁剪发生在内存中的消息数组上，与压缩同理——历史
  反映的是模型可见视图。
