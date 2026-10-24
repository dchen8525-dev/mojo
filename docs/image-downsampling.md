# 批次 41：图片降采样（jimp）

状态：已实现（2026-10-24）｜依赖已批准（jimp 1.6.1）

## 背景

此前 `validateImages` 对超过 `AGENT_MAX_IMAGE_BYTES`（默认 5 MiB）的图片**硬拒绝**，粘贴截图或拖入手机照片经常直接失败；即使没超字节上限，超长边图片也会原样上传。ZCode 的做法是在进入模型前用 jimp 做 `prepareForModel`：按最长边与字节预算渐进缩放/换编码。本批次移植该思路，并接入 mojo 已有的媒体预算。

## 模块（src/imageResize.ts）

- `imagePrepareLimits()`：从 `mediaLimits().perImageBytes` 与 `AGENT_IMAGE_MAX_EDGE` 组装预算。
- `prepareImagesForModel(images, limits?, { signal }?)`：逐张处理，返回 `{ images, resized }`；**已达标图片原对象返回**（`resized` 计数只统计真正被改写的图片）。
- `prepareImageForModel`：只处理 `base64` 源；WebP 直接透传（jimp 1.6 不能转码 WebP）；先用文件头探测格式与长宽，只有超字节或超长边时才 `await import("jimp")`——**jimp 是惰性加载**，常规小图不付启动成本。
- `detectMediaType` / `imageDimensions`：按 magic bytes 解析 PNG / JPEG / GIF / BMP（JPEG 扫描 SOF 段，BMP 支持负高度 top-down 位图），不解码像素。
- 压缩阶梯（命中即停）：
  1. 最长边缩到 `maxEdge`；源格式保留（PNG deflate 9 仅试一次；JPEG 走质量阶梯；GIF 原格式重编码）。
  2. 同一尺寸的 JPEG 质量阶梯 `80/60/40/20`。
  3. 依次缩到 `0.75 / 0.5 / 0.25` 最短边，每档先试保留格式（PNG 除外）再试 JPEG。
  4. 激进档 `1000/800/600/400/300/200`，JPEG 质量 `60/40/20`。
- 全部候选都超预算时返回原图，让 `validateImages` 给出原有的大小错误；无法解码的数据也原样放行（由 provider 或校验报错），不吞掉错误。
- 解码前防线：
  - base64 解码后的输入超过 64 MiB（`MAX_INPUT_BYTES`）直接拒绝，配置的字节预算再大也不能让进程先吃下数百 MB；
  - 头部声明尺寸超过 2400 万像素（解压炸弹）直接报错，不进入 jimp，避免按 4 字节/像素分配内存；
  - 超预算且尺寸/格式都无法廉价测量的容器（TIFF、AVIF 等）不交给解码器，原样交给 `validateImages` 拒绝。
- 每个阶段检查 `AbortSignal`，用户中断回合时立即抛 `aborted`。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_IMAGE_MAX_EDGE` | `1568` | 图片最长边目标；与 Anthropic 服务端缩放边长一致，降低上传体积而不损模型可见细节。`0` 关闭按尺寸缩放（仍按字节压缩） |
| `AGENT_MAX_IMAGE_BYTES` | 5 MiB | 既有单图字节上限，现在作为压缩目标而非直接拒绝线 |
| `AGENT_MAX_IMAGES_PER_MESSAGE` | 5 | 既有单条消息图片数上限，仍硬拒绝（不压缩数量） |

## 接线

| 入口 | 处理 |
|---|---|
| `Agent.chat` | 入口处先 `prepareImagesForModel(..., { signal })`，再 `validateImages`；压缩后的图片才进入历史/会话文件，后续恢复也不再携带原图 |
| GUI `/api/chat` 的 steer 分支 | 路由内先异步压缩再调用同步的 `Agent.steer`；普通排队输入在真正开跑时经 `chat` 压缩 |
| TUI 回合中段输入 | `onSubmit` 内先压缩再 `agent.steer` |
| `Agent.steer` 本身 | 保持同步，仅做计数/字节校验；调用方负责预压缩（当前两处调用方均已接入） |
| bash 输出图片（bashHints） | 维持原有入口限额（每段最多 2 张、单张 5 MiB），未走本模块；超出仍以文本占位 |

会话内常驻图片仍由 `enforceSessionMediaBudget` 在每轮发送前按最旧优先改写为占位文本。

## 限制

- WebP 只透传，超过字节上限时仍会被 `validateImages` 拒绝。
- 透明 PNG 转 JPEG 时透明区域会变黑（jimp 默认行为；仅在需要激进压缩时发生）。
- 动态 GIF 只有超出预算被压缩时才会被压成静态帧。
- 工具结果里的 base64 图片不经过本模块。

## 测试

- `tests/imageResize.test.ts`（14）：PNG/JPEG/GIF 文件头探测、小图零改写、`maxEdge=0` 关闭尺寸缩放、按最长边等比缩放且保留 PNG、按字节上限多次重编码、必须转 JPEG 的场景、WebP 透传、不可解码数据放行、解压炸弹拒绝、abort、多图只改超限者。
- `tests/mediaBudget.test.ts`（+2）：`imageMaxEdge` 默认/空值/显式值/`0`/非法值、运行时读取环境变量。
- `tests/agent.test.ts`（+1）：`Agent.chat` 收到超限图片时首个请求里的图片已被压到字节上限内。

## 验证

`npx vitest run`：90 文件 / 1245 通过 / 7 跳过；`npm run lint`、`npm run build` 全绿。

真实构建产物验证（`dist/imageResize.js`，默认限额）：

- 800×600 PNG（2.9 KB）：`resized=0`，0.8 ms——未加载 jimp。
- 1920×1080 PNG（11.6 KB）：最长边缩至 1568，保留 PNG，11.6 KB → 9.6 KB，约 0.8 s（含 jimp 首次加载）。
- 2000×1500 随机噪声 PNG（8.9 MB，超 5 MiB）：降为 1568×1176 JPEG，2.4 MB，约 3.9 s。
