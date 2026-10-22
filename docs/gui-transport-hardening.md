# GUI 传输与会话存储加固

## 状态

- 2026-10-22 落地。本文约束本地 GUI 的请求体、令牌、SSE 背压与会话文件权限。

## 请求体上限

- 所有 `POST /api/*` 的请求体默认上限 64 MiB，可用 `AGENT_GUI_MAX_BODY_MB` 调整；
  超限返回 `413 {"error":"request body too large (limit N MB)"}`。
- 超限后继续读取并丢弃剩余数据（不缓存），既不会无限占内存，也不会让连接半途卡死。
- 默认值覆盖多张 5 MiB 图片（base64 后约 6.7 MiB/张）的常见批次。

## 令牌

- 所有 `/api/*` 请求必须带 `x-agent-token` 头。
- 查询参数 `?token=` **只**在 `GET /api/events` 上被接受：浏览器 `EventSource` 无法设置
  自定义头，其余接口一律要求请求头，避免把令牌留在 URL、日志或历史记录里。
- 令牌比较使用 `crypto.timingSafeEqual`（长度不等直接失败）。

## SSE 背压

- 每个客户端在服务端缓冲的未发送数据超过 4 MiB 时被判定为慢客户端：从广播集合移除、
  销毁连接；若这是最后一个客户端，会触发 `onEmpty`（GUI 用它拒绝挂起的权限询问）。
- 写入异常同样移除客户端，不会因为一个坏连接中断其他订阅者。

## 会话文件

- `~/.node-agent/sessions` 目录权限 0700（已存在的目录也会被收紧）。
- 会话文件以 `mode: 0600` + `flag: "wx"` 创建：id 冲突时重新生成而不是覆盖已有会话。
- 后续追加沿用文件权限；`rewriteMessages` / 元数据更新继续原子写入并保持 0600。

## 定时任务目录

- 创建任务或修改 `cwd` 时，目录必须存在且是目录，否则报
  `cwd is not a directory: <path>`。
- 仅切换启用状态或修改其他字段时不重新校验，避免历史任务因目录暂时离线而无法编辑。

## 代码与测试

- `src/gui/server.ts`：`readBody`（上限/413）、`authorized`（令牌作用域与常量时间比较）。
- `src/gui/sse.ts`：慢客户端阈值与丢弃逻辑。
- `src/session.ts`：`createSession` 权限与 `wx` 创建。
- `src/cron.ts`：`assertCwd`。
- 测试：`tests/guiServer.test.ts`、`tests/sseHub.test.ts`、`tests/session.test.ts`、
  `tests/cron.test.ts`。
