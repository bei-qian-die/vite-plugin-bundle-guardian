# 本目录下的文件都是 `bundle-guardian` 的真实产出，不是手写样例。

```bash
# 复盘这两条命令，就能得到本目录的所有文件
pnpm build

# ① 分析自己的构建产物
node packages/cli/dist/index.js analyze packages/core/dist \
     --json examples/report.json --html examples/index.html --md examples/report.md

# ② 用预算门禁检查（examples/budget.json 故意设得很严，会触发 exit 1）
node packages/cli/dist/index.js check packages/core/dist \
     --budget examples/budget.json --ci
echo $?   # → 1，CI 里这一行会让整个流水线失败
```

| 文件 | 说明 |
| --- | --- |
| `budget.json` | 预算配置示例（四类匹配：`each` / `maxTotal` / `contains`） |
| `report.json` | 机器可读报告，`diff` 与 `why` 命令的输入 |
| `report.md` | PR 评论用的 Markdown |
| `index.html` | **成品图**：单文件 HTML 报告，含自研 treemap，离线双击即可打开 |
