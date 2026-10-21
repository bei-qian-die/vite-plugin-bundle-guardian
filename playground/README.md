# playground · 体积治理靶场

一个 Vue 3 + Element Plus + ECharts 的中后台，**故意埋了各种体积坏味道**，用来验证 `bundle-guardian` 的检测能力与治理收益。

## 用法

```bash
pnpm build          # 同时产出 dist-before / dist-after
pnpm build:before    # 仅治理前
pnpm build:after    # 仅治理后
```

两种模式通过 Vite 的 `resolve.alias` 切换实现，源码只写一份：

| alias | before（坏味道） | after（治理后） |
| --- | --- | --- |
| `@date` | `utils/date.ts` — moment 全量 + 5 个 locale | `utils/date.after.ts` — dayjs + 单个 locale |
| `@helper` | `utils/helper.ts` — `import _ from 'lodash'` | `utils/helper.after.ts` — lodash-es 单点引入 |
| `@chart` | `utils/echarts.ts` — `import * as echarts from 'echarts'` | `utils/echarts.after.ts` — core + 按需 use() |
| `@ui` | `utils/ui.ts` — Element Plus 全量注册 + 全量 CSS | `utils/ui.after.ts` — 按需组件 + 各自 css |

after 模式额外开启了 `manualChunks` 按厂商分包。

## 埋了哪些雷

| 坏味道 | 会被哪条规则抓到 |
| --- | --- |
| moment 全量 + locale 全打包 | `full-locale-import` |
| lodash CJS 全量引入 | `heavy-package` / `cjs-bundled` |
| echarts 全量（只用了折线/柱/饼） | `heavy-package` + `no-dynamic-import` |
| Element Plus 全量注册 | `heavy-package` + 全量 CSS |
| `store/user.ts` ⇄ `api/auth.ts` 互相引用 | `circular-dep`（Tarjan SCC） |
| 声明了但不用的 `qs` / `clipboard` / `js-md5` | `unused-dep` |
| 单产物 755 KB 不分包 | `single-huge-chunk` |

## 实测结果

| 指标 | before | after | 变化 |
| --- | ---: | ---: | ---: |
| JS gzip | 765.7 KB | 506.0 KB | **−33.9%** |
| CSS gzip | 48.9 KB | 19.5 KB | **−60.2%** |
| 产物数 | 3 | 9 | — |
| echarts 归因 | 265.6 KB | 115.7 KB | −149.9 KB |
| moment → dayjs | 44.3 KB | 0 | −44.3 KB |
| zrender（双版本） | 94.0 KB | 55.3 KB | −38.7 KB |
| lodash（CJS 全量） | 24.4 KB | 0（lodash-es 10.0 KB） | −14.4 KB |
| 规则诊断数 | 5 err / 7 warn | 4 err / 2 warn | — |

8 条内建规则在 before 模式下**全部被触发**，after 模式只剩 4 条：
`full-locale-import`、`duplicate-dep`、`cjs-bundled`、`no-dynamic-import` 已全部消失。

> after 模式剩下的 error 主要是 element-plus（244 KB）和 echarts（115 KB）本身仍然很大 ——
> 这说明规则在持续给出下一步优化方向：改成路由级动态 import。

## 报告在哪

- `dist-before/__guardian/index.html` —— 治理前报告
- `dist-after/__guardian/index.html` —— 治理后报告

两个都是单文件、离线可打开，直接对比 treemap 就能看到体积是怎么掉下去的。
