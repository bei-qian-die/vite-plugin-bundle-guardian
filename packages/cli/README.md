# bundle-guardian

构建产物治理 CLI：分析产物、卡体积门禁、追溯依赖引入链。零第三方依赖。

```bash
npm i -D bundle-guardian
```

```bash
bundle-guardian analyze [dir]         # 分析构建产物（默认 dist）
bundle-guardian check   [dir]        # 体积门禁，超限 exit 1
bundle-guardian why     <pkg>        # 打印最短引入链 + 实际用到的导出
bundle-guardian compare <a> <b>      # 两份 report.json 生成对照报告
bundle-guardian diff    <a> <b>      # 包级增量对比
bundle-guardian history              # 体积趋势（ASCII 折线）
bundle-guardian vscode-task          # 输出配套的 VSCode tasks.json
```

常用参数：`--budget` `--baseline` `--update-baseline` `--ci` `--html/--json/--md`
`--format vscode` `--lighthouse <file>` `--record` `--alias k=v` `--cache` `--open` `--quiet`

```bash
# CI 里最典型的用法
bundle-guardian check dist --ci --update-baseline --record
echo $?   # 1 = 体积回归，流水线失败
```

完整文档见仓库根目录的 [README](../../README.md)。
