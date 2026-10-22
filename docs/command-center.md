# GUI 命令中心（Ctrl/Cmd + P）

状态：已合入 main（2026-10-22）。

## 行为

- **入口**：侧栏底部「⌘ 命令」按钮，或全局快捷键 **Ctrl/Cmd + P**（与 Ctrl+K 会话搜索、Ctrl+F 查找并列；有其它弹窗打开时不响应）。
- **内容**：单一面板聚合
  - 全部内置斜杠命令（`BUILTIN_CMDS`，含新增的 `/doctor` 诊断体检）；
  - 项目/用户自定义命令（custom commands，永远按需预填）；
  - 10 个 UI 操作（新建会话、会话搜索、切换项目、LLM 配置、权限模式、待办面板、后台任务、用量仪表盘、MCP 与权限管理、快捷键清单），直接复用既有按钮/弹层的 click 链路。
- **执行语义**（与输入框 "/" 内联补全的尾随空格约定一致）：
  - 无参命令（如 `/doctor`、`/clear`）→ 写入 composer 后走 `send()`，与手输完全同一条 `/api/chat` 链路；
  - 带参命令（`BUILTIN_CMDS` 名字以空格结尾，如 `/resume`、`/review`、`/search`）→ 只预填输入框并聚焦，不自动执行。`/review` 由无参改为带参（重命令，可选目标）。
- **交互**：输入即时过滤（name+desc 子串，大小写不敏感）；↑↓ 循环选择、Enter 执行当前项、Esc 关闭并恢复焦点、点击遮罩关闭；列表上限 50 条。

## 涉及文件

- [src/gui/static/app.js](../src/gui/static/app.js)：`CMDK_ACTIONS`、`openCommandCenter/closeCommandCenter/renderCmdk/cmdkMove/cmdkActive/runCmdk`（紧跟 `applyPalette` 之后）；全局键新增 Ctrl/Cmd+P 分支；`BUILTIN_CMDS` 增 `/doctor`、`/review` 改带参。
- [src/gui/static/index.html](../src/gui/static/index.html)：`#cmdk-modal`（input + list + hint）、侧栏 `#cmdk-btn`、帮助清单加 `Ctrl / Cmd + P` 行。
- [src/gui/static/style.css](../src/gui/static/style.css)：`.cmdk-card/.cmdk-list/.cmdk-item(.active)/.cmdk-kind/.cmdk-name/.cmdk-desc/.cmdk-empty/.cmdk-hint`。

## 测试

- [tests/guiDom.test.ts](../tests/guiDom.test.ts) 新增 4 例：Ctrl+P 打开与过滤、无参命令经 composer 发送 `/api/chat {text:"/clear"}`、带参命令预填且不发请求、UI 动作打开帮助弹窗。

## 现场验证（真实 GUI 进程）

- 面板打开 34 条目；过滤 `doctor` → 仅 `/doctor`，回车后真实执行，诊断清单渲染（Key 以 sk-… 掩码显示）。
- `/resume` 预填 ✓；「快捷键」动作打开帮助 ✓；其它弹窗打开时 Ctrl+P 被正确拦截 ✓；Esc 关闭并恢复焦点 ✓。
- 注意：应用内嵌浏览器的真实按键事件不可靠（与前几批一致），Ctrl+P 处理器以合成 keydown + happy-dom 双重验证。
