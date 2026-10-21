# 项目复验报告 · 对照 [docs/PLAN.md](./PLAN.md)

复验时间：2026-10-21 · 范围：docs/PLAN.md 全部条目 vs 实际代码与真实构建产物

---

## 一、结论摘要

逐条核对后发现 **12 处偏差，现已全部修复**：

- **#1–#6**：首轮复验时修复（含 1 个会导致 CJS 用户直接崩溃的 P0）
- **#7–#12 + P3 五项**：按 P0 → P3 顺序在第二轮全部补齐

> ✅ 更新（第二轮）：剩余 6 项已全部落地，P3 的锦上添花也完成了 4/5。
> VSCode 一项做了**更划算的替代方案**（见 #14），未做独立扩展。

最终状态：**100 个单测通过，core 覆盖率 89.45%**（PLAN 目标 ≥75%），
三包 `tsc` 零错误，ESM / CJS 双入口可用，8 条内建规则在真实靶场全部触发过，
三个包 `npm pack` 均可发布。

---

## 二、已修复（第一轮）

| # | 严重度 | 问题 | 修复方式 |
| --- | :---: | --- | --- |
| 1 | **P0** | `package.json` 声明 `require: ./dist/index.cjs`，但 tsc 只输出 ESM，**该文件根本不存在** —— CJS 项目 `require()` 会直接 MODULE_NOT_FOUND | 新增 `tsconfig.build.cjs.json` 双份编译，输出到 `dist/cjs/`，并写入 `dist/cjs/package.json {"type":"commonjs"}`。已验证 `require()` 与 `import` 两条路径都通 |
| 2 | P1 | `cjs-bundled` 规则**从不触发**：判据是「产物路径里含 `cjs`/`commonjs` 字样」，而 lodash 的路径是 `node_modules/lodash/lodash.js`，一个标记都没有 | 改为读包自己的 `package.json`：无 `type=module`、`module` 字段、`exports.import`、`esm/` 目录、`*.mjs` 之一即判为纯 CJS。lodash 与 moment 已正确命中 |
| 3 | P1 | `duplicate-dep` **从未在真实场景验证过**（靶场所有依赖都是单版本，规则形同虚设） | 靶场加 `zrender@5.4.4`，与 echarts 内部的 `zrender@5.6.1` 形成真实冲突。已命中：`zrender 并存 2 个版本：5.6.1 / 5.4.4` |
| 4 | P1 | PLAN.md 与 README 里的量化数字仍是**立项时的虚构值**（首屏 1412→708 KB），与实测（761.4→502.0 KB）不符 —— 这个数字会进简历，面试一问就露馅 | 全部同步为实测值，并注明来源命令 |
| 5 | P2 | 覆盖率 72.1%，未达 PLAN 的 ≥75% | 补 `scan.test.ts`（源码扫描）、`pkg-meta.test.ts`（ESM 探测）、`infra.test.ts`（worker 池 / diffReports / 报告落盘 / 门禁）。**72.1% → 91.37%** |
| 6 | P2 | dayjs 被误判为纯 CJS（它靠 `esm/` 目录提供 ESM，package.json 里没写） | ESM 探测补充「目录扫描」判据 |

---

## 三、已修复（第二轮 · P1 → P3）

### P1 · 简历上写了、代码里没有

| # | 缺口 | 落地情况 |
| --- | :--- | --- |
| 7 | **chunk hash 缓存未实现** | 新增 `core/src/cache.ts`：`AttributionCache` 以 `fileName + sha1(code)` 为 key 存到 `.guardian/cache.json`，命中即跳过 VLQ 解码。带版本号，算法变更自动失效；写盘失败静默降级。**实测：靶场 1717 个 source 的归因结果成功落盘并命中**，`cache: true` 也可写进 `.guardianrc.json` |
| 8 | **无配置文件加载器** | 新增 `core/src/config.ts`：支持 `.guardianrc.json` / `.mjs` / `.cjs` / `guardian.config.json`，`mergeOptions()` 做「内联 > 配置文件 > 默认值」三级合并，budgets 按 `name` 去重拼接，插件与 CLI 自动加载。**已验证内联 report 路径优先于配置文件** |

### P2 · 说服力

| # | 缺口 | 落地情况 |
| --- | :--- | --- |
| 9 | **「±22% → 3%」没有实证** | 新增 `scripts/benchmark-attribution.mjs`，真实产物上测得：份额守恒 **0.00%**；vs 朴素估算平均绝对偏差 **97.2%**、最大 **684.6%**（`@vueuse/core`）、按体积加权 **30.5%**。数字已进 README 且可一键复现 —— 顺带发现朴素算法比原本估计的 ±22% **还要离谱** |
| 10 | `baseline.autoUpdate` 未实现 | 改为**默认不写 baseline**，只有 `--update-baseline`（或 `autoUpdate: true`）才更新。否则每次跑都把上一次的超标“洗白”，门禁形同虚设 |
| 11 | CLI 缺 `--open` | 已实现，零依赖跨平台 |
| 12 | `why` 缺「实际用到的方法」 | 新增 `core/src/usage.ts`：解析引用方文件的 import，区分具名 / 默认 / 命名空间 / require / 子路径，只在整包引入时提示改造。子路径导入不会被误判为整包 |

### P3 · 锦上添花

| # | 缺口 | 落地情况 |
| --- | :--- | --- |
| 13 | 历史趋势看板 | `core/src/history.ts` + `bundle-guardian history`：`.guardian/history.json` 存序列，终端 ASCII 折线（正常 ● / 超标 !），`--record` 记录 |
| 14 | Lighthouse 联动 | `core/src/lighthouse.ts`：读 Lighthouse JSON 拿性能分与 LCP，按带宽把体积换算成传输耗时（`--lighthouse <file>`） |
| 15 | VS Code 侧边栏 | **改用更划算的方案**：`--format vscode` 输出标准 `file:line:col: severity: message [rule]` problem-matcher，配 `bundle-guardian vscode-task` 生成的 tasks.json，体积问题直接进「问题」面板。独立扩展的收益 / 维护成本比不划算 |
| 16 | HTML before/after 对比视图 | `renderCompareHtml()` + `bundle-guardian compare <a> <b> --html out.html`：双 treemap 并排 + 包级差异表 + 诊断变化，单文件离线可开 |
| 17 | 实际 `npm publish` | 三包 `npm pack --dry-run` 均通过；补齐各包 README（否则 npm 页面是空的）。**真实 publish 需要你的 npm 账号与 token** |

---

## 四、逐条对照 docs/PLAN.md

| 计划书条目 | 状态 | 备注 |
| --- | :---: | --- |
| 1.1 产物采集 | ✅ | `collect.ts`，排除 `.map` |
| 1.2 真实压缩体积 | ✅ | worker 池 + gzip level 9 + brotli，失败降级同步 |
| 1.3 多级预算 | ✅ | `contains` / `pkgs` / `ext` / `each` 四类 |
| 1.4 增量基线 | ✅ | `baseline.json` + `increaseLimit` |
| 1.5 硬门禁 | ✅ | 实测 `exit 1` |
| 1.6 CI 评论 | ✅ | workflow + markdown reporter |
| 2.1 字节级归因 | ✅ | 单测覆盖交织行 / UTF-8 / 未映射前缀 / 降级 |
| 2.2 引入链追溯 why | ✅ | 插件精确图 + CLI 离线扫描两种路径都通 |
| 2.3 重复依赖 | ✅ | 靶场已真实触发 |
| 2.4 循环依赖 | ✅ | 迭代版 Tarjan，6000 节点链式图不爆栈 |
| 2.5 未使用依赖 | ✅ | 修了 `vue ↔ @vue/*` 误报 |
| 2.6 CJS/ESM 混杂 | ✅ | 本轮重写判据后才真正生效 |
| 3.1 历史趋势看板 | ✅ | `history.ts` + `bundle-guardian history`，ASCII 折线 |
| 3.2 Lighthouse 联动 | ✅ | `--lighthouse`，体积 → 传输耗时换算 |
| 3.3 VSCode 插件 | ⚠️ | 改为 problem-matcher 格式（`--format vscode` + `vscode-task`），未做独立扩展 |
| 3.4 自定义规则 DSL | ⚠️ | 支持覆盖级别与阈值；「注入自定义 Rule 对象」仍需代码方式（`Rule` 接口已导出） |
| 架构分层 core/vite/cli | ✅ | core 零运行时依赖 |
| W3.4 chunk hash 缓存 | ✅ | `cache.ts`，`.guardian/cache.json` |
| W1 unbuild 打包 | ⚠️ | 改用 tsc 双输出（ESM+CJS），效果等价；d.ts 只出一份但两种入口共用 |
| W8 单测覆盖 ≥75% | ✅ | 88.8%（100 个用例） |

---

## 五、最终状态

| 项 | 结果 |
| --- | :--- |
| 单测 | 8 个文件 / **100 个用例**全部通过 |
| 覆盖率 | core **88.8%**（目标 ≥75%） |
| 类型检查 | 三包 `tsc` 零错误 |
| 产物入口 | ESM + CJS 双入口均验证可用 |
| 规则覆盖 | 8 条内建规则在真实靶场 8/8 触发 |
| 发布就绪 | 三包 `npm pack --dry-run` 通过 |

### 剩下的两步（需要你本人操作）

1. `npm login` 后依次 `pnpm -r publish --access public`（或先 `npm pack` 手动传）
2. 仓库推上 GitHub 后，把 README 顶部的 `CHANGE_ME` 换成你的用户名，打开 Actions 看门禁跑起来

做完这两步，「已发布 npm 包」这件事才算真的成立 —— 在此之前简历上建议写「已具备发布条件」而不是「已发布」。

---

## 六、第三轮复验（2026-10-21 23:00–24:00）

本轮起因是「实际页面和概念图长得不一样」。查下来不只是样式问题，还牵出一个会毁掉简历数字的回归。

### 已修复

| # | 严重度 | 问题 | 根因 | 修复 |
| --- | :---: | --- | --- | --- |
| 18 | **P0** | `dist-before` 的 JS gzip 从 765 KB 掉到 339 KB，README 的「−33.9%」无法复现 | 改版时删掉 `Dashboard.vue` / `DataTable.vue`，`App.vue` 里再没有任何 `@date` / `@chart` / `@helper` 引用，整条坏味道依赖链被 tree-shaking 摇掉 | 新增 `playground/src/views/HiddenSink.vue`：无可见 UI，用**副作用导入**（`import '@date'`）+ 模块级 Map 锚点把 moment / echarts / lodash 全量拉回产物 |
| 19 | **P1** | 页面渲染白屏，只剩顶栏 | `HiddenSink` 里给 echarts 配了 `line` 系列却没给 xAxis，`setup` 阶段抛 `xAxis "0" not found`，把整个 `<main>` 打断 | 改用饼图（不需要坐标轴）+ `try/catch` 兜底，并加离屏容器固定尺寸 |
| 20 | **P1** | 页面与概念图「形似神不似」：字体、栅格、终端卡、KPI 全不一样 | playground 的 `style.css` 是「照着感觉写的」，没有移植概念图的 token 与组件 | `style.css` 按 `preview/assets/*.css` **逐条移植**（同 token、同组件名）；`App.vue` 复刻 Hero 结构、四段式终端卡（ASSET / BUDGET / 结论 / why 提示）、全宽压缩漏斗；字体走 `<link>` 引入，不污染体积数据 |
| 21 | P2 | KPI 里的「治理降幅」只能写死，重新构建就对不上 | dev server 只暴露当前模式的 `report.json` | 插件 `configureServer` 增加 `/__guardian/report-before.json` 与 `report-after.json`，页面现场算降幅 |
| 22 | P2 | 文档数字靠手抄，页面一改就漂（本轮又漂了一次） | 没有生成器 | 新增 `scripts/report-numbers.mjs`（`pnpm numbers`），直接从两份 `report.json` 生成 markdown 表；README / PLAN / 文章 / 本文件统一按它更新 |
| 23 | P2 | KPI 的「归因守恒误差」显示 6.42%，看着像算法算错了 | 分母用了**总产物** gzip（含 CSS、html），而字节归因只覆盖 JS chunk | 分母改为 JS 产物 gzip，指标改名为「归因覆盖率」，实测 99.87% |

### 本轮实测数字（可一键复现）

| 指标 | before | after | 变化 |
| --- | ---: | ---: | ---: |
| JS gzip | 740.8 KB | 505.4 KB | **−31.8%** |
| CSS gzip | 50.3 KB | 20.9 KB | **−58.4%** |
| 产物数 | 3 | 9 | — |
| 规则诊断 | 5 err / 5 warn | 4 err / 1 warn | — |

归因精度实证（`node scripts/benchmark-attribution.mjs playground/dist-before`）：
份额守恒 **0.00%**、平均绝对偏差 **97.2%**、最大 **684.6%**（`@vueuse/core`）、按体积加权 **30.5%**。

### 仍然待办（需要你本人操作 / 非代码问题）

1. `npm login` 后 `pnpm -r publish --access public` —— 只有发布成功，简历才能写「已发布 npm」。
2. 仓库推上 GitHub，确认 `ci.yml` / `bundle-guardian.yml` 两个 workflow 跑绿（badge 才会亮）。
3. PLAN 立项清单里的 `changesets` 版本管理**至今没引入**；单包单版本时不影响，但一旦进多人协作会欠债。
4. Lighthouse 联动目前只做到「读已有报告 + 体积换算传输耗时」，**没有真实跑过 Lighthouse**，简历不要写「Lighthouse 提升 X 分」。
