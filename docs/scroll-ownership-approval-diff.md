# 滚动所有权与审批 diff

## 状态

- 2026-10-22 落地。本文约束 GUI 会话流的视口所有权与权限弹窗的 diff 呈现。

## 滚动所有权（transcript）

- 会话容器只有两种状态：FOLLOWING（视口钉在流末尾）与 DETACHED（用户在回看）。
  判定阈值 `BOTTOM_SLACK = 32px`（`src/gui/static/app.js`）。
- 只有真实的滚动输入能改变状态：`#transcript` 上的 `scroll` 事件是唯一裁决点。
  流式追加一律经 `scrollBottom()`，它自带 `follow.lock` 标记，滚动处理器据此把
  自己的钉底事件与用户滚动区分开——程序化追加永远不会抢走视口。
- DETACHED 时：新内容照常追加但不滚动；浮出「↓ 回到底部」按钮（`#jump-bottom`，
  绝对定位于 `#transcript-wrap`）。点击按钮或滚回底部 32px 内都重新跟随。
- 发送新消息视为「看最新」的明确意图：`send()` 先强制 FOLLOWING 再发出请求。
- `refreshState()` 全量重绘时保留 DETACHED 的 `scrollTop`，FOLLOWING 则重绘后钉底；
  重绘不会把回看中的用户拽回末尾。
- 结构：`index.html` 把 `#transcript` 包进 `#transcript-wrap`（`position:relative`），
  按钮挂在 wrap 内；CSS 见 `style.css` 的 `#transcript-wrap` / `#jump-bottom`。

## 审批 diff

- `write_file` 现在生成与 `edit_file` / `multi_edit` 相同形状的统一 diff 作为审批
  preview（`src/tools/write.ts`）：新建文件是 `@@ -0,0 +1,N @@` 的全加行；覆盖文件用
  `renderDiff(old, 全文替换)` 产出删除/新增行；读取旧文件失败时退化为无 preview。
  超过 120 行截断并追加 `[... preview truncated: N more lines]`。
- GUI 权限弹窗（`showPermission`）用 `looksLikeDiff` 识别 diff 形状的 preview，按
  `renderDiffPreview` 渲染为结构化行：旧/新行号双栏（CSS grid）、`@@` 与 `---`/`+++`
  等文件头渲染为 meta 行、`+`/`-` 行沿用红绿配色并加底色。非 diff 的 preview
  （计划、命令行）保持原有的纯文本着色渲染。
- Ink 终端 UI 不变：`src/ui/splitDiff.ts` 本就按 hunk 头解析，write_file 的新 preview
  自动获得同样的分栏视图。

## 测试

- `tests/guiStatic.test.ts`：按钮/wrap/锁定标记的接线断言；pin 赋值只允许出现在
  `scrollBottom()` 一处；diff 行渲染与回退分支的样式接线。
- `tests/editMatch.test.ts`：write_file 的三种 preview（新建、覆盖、超长截断），
  通过捕获 `askPermission` 的第三个参数断言。
- 已用真实小回合在浏览器中验证：创建 `scroll-test.txt` 的审批弹窗出现 hunk 头、
  行号 1–4 与着色行；批准后文件内容正确（验证后已删除）。
