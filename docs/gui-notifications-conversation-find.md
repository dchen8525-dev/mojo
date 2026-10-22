# GUI 任务通知与会话内查找

## 状态

- 2026-10-22 落地。两个纯前端功能：窗口失焦时的任务通知，以及 Ctrl+F 会话内查找。

## 任务通知

- 只在 `document.hidden` 时生效；可见窗口本来就在看流，不打扰。
- 触发事件：
  - `turn_end` — 回合完成（正文取最后一段模型回复的前 140 字符）。
  - `turn_error`（非中断）— 回合出错。
  - `permission_request` — 等待权限批准（回合被阻塞时提醒最有价值）。
  - 后台 shell 任务完成 — 由 10 秒轮询对比前后两次 `/api/background` 的运行集合，
    上次在跑、这次结束且非 `killed` 的任务触发；exit code 非 0 时标题为「后台任务失败」。
- 呈现：`Notification` API 已授权则发系统通知（`tag: "mojo"` 去重，点击聚焦窗口）；
  权限为 default 时懒请求授权；不可用时静默。
- 兜底：无论通知是否可用，标题栏显示 `(N) mojo` 未读计数，窗口获得焦点或重新可见时清零。
- 轮询不再跳过隐藏窗口（每 10 秒一次的轻量 JSON 请求），否则失焦时永远发现不了任务结束。

## 会话内查找

- `Ctrl / Cmd + F` 打开 `#transcript-wrap` 右上角的悬浮查找条；Escape（输入框内或全局）关闭。
- 匹配按转写区**顶层块**（用户/助手消息、思考卡、整组工具卡）的大小写不敏感包含判断；
  命中块加 `.find-hit` 描边，当前项加 `.find-current`。不做 Markdown 渲染 DOM 内的
  文本级高亮——对渲染后的 DOM 做节点拆分太脆，块级定位已够用。
- 导航：Enter 下一个、Shift+Enter 上一个、↑/↓ 按钮同效；计数显示 `n / m` 或「无结果」。
- 定位用 `scrollIntoView({ block: "center" })`：落在离底部较远处时，滚动所有权
  （见 scroll-ownership-approval-diff.md）会自然把视口切到 DETACHED。
- `refreshState()` 全量重绘会丢掉描边，查找条开着且有查询词时自动重跑查找。
- 快捷键帮助弹窗新增 `Ctrl / Cmd + F` 条目。

## 不做的事

- 不改后端：通知与查找都基于现有 SSE 事件和轮询接口。
- 不做跨会话搜索（侧栏已有标题/标签搜索）。

## 代码与测试

- `src/gui/static/app.js`：`notifyUser` / `flashTitle` / `bgPrevRunning` 差分；`runFind` /
  `gotoFind` / `setFindOpen`；全局键位接线。
- `src/gui/static/index.html`、`style.css`：查找条 DOM 与样式、帮助条目。
- `tests/guiStatic.test.ts`：通知钩子齐全且仅隐藏时生效、轮询不再被 `document.hidden`
  拦截；查找条 id 接线、Ctrl+F、重绘后重跑查找、帮助条目。
