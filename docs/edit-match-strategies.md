# edit_file 多策略模糊匹配(带歧义检测)

状态:已合入 main(2026-10-22)。借鉴 ZCode `packages/core/src/tool/edit-matchers.ts`。

## 行为

`edit_file` 的 `old_string` 匹配按"由紧到松"的固定顺序尝试,前一级无命中才进入下一级:

1. **精确字节匹配**(原行为);
2. **空白归一**:逐行忽略首尾/连续空白,替换文本自动重缩进(原行为);
3. **引号归一**:`“”‘’` 等弯引号与 NBSP 映射为 ASCII(模型从散文/PDF 复制的典型污染);
4. **行号前缀剥离**:剥离 `12\t` / `12: ` / `12| ` 前缀(模型直接照抄 read_file 输出);
5. **转义归一**:字面 `\t` `\uXXXX` `\"` 等序列还原为真实字符;
6. **块锚点相似度**(最后手段):≥3 行的块,归一化后首尾行必须相等、中间行相似度(相等=1,包含=0.8)≥ 0.8;**仅唯一候选才应用**。

## 歧义处理

- 非锚点策略多候选:维持原行为——报错并列出全部行号,除非 `replace_all`。
- 锚点匹配多候选:一律拒绝(相似度匹配不允许 replace_all),错误信息明确提示"loose similarity match lands in several places",并附 nearestMiss 最近区域。

## 涉及文件

- [src/tools/editMatch.ts](../src/tools/editMatch.ts):`MATCH_STRATEGIES` 策略链、`unquote`/`stripLineNumber`/`unescapeSeq`、`findAnchorEdits`;`FuzzyResult.ambiguous` 标志。
- [src/tools/write.ts](../src/tools/write.ts):歧义提示接入;工具描述更新。
- multi_edit 保持仅精确匹配(有意为之,批量场景不容模糊)。

## 测试

[tests/editMatch.test.ts](../tests/editMatch.test.ts) 新增 8 例:弯引号、行号前缀、转义序列、锚点唯一命中、锚点多候选歧义、锚点首尾行漂移拒绝、edit_file 歧义提示;原 18 例不变。

## 冒烟

对 dist 构建产物以 node 直跑三种策略均按预期命中/拒绝。
