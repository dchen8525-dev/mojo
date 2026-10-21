# 技能系统（SKILL.md + 渐进披露）

## 状态

- 2026-10-21 落地（c4ff6b2）。本文是技能发现与加载的规范。

## 布局与发现

- 技能是含 `SKILL.md` 的目录，存放于 `~/.node-agent/skills/`（用户级）与 `<cwd>/.node-agent/skills/`（项目级）。
- `SKILL.md` 使用最小 frontmatter：`name`、`description`（无 YAML 依赖；缺 name 时回退目录名）。
- 同名时项目级遮蔽用户级。

## 注入与加载

- 系统提示词注入 `<available_skills>` 块：仅 name + description（渐进披露，几行 token）。
- `skill` 工具按需加载全文，包裹为 `<skill name="..." source="...">`，40k 字符截断。
- `isReadOnly: true`：加载技能无副作用，不弹权限。

## 代码

- `src/skills.ts`（解析/发现）、`src/tools/skill.ts`（工具）。
- 测试：`tests/skills.test.ts`。
