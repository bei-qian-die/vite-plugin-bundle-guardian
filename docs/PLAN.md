# vite-plugin-bundle-guardian · 项目计划书

> **构建产物治理插件：体积守护 + 依赖分析**
> 一句话定位：让"包体积失控"从**事后发现**变成**提交即拦截**的工程化门禁。

| 项 | 内容 |
| --- | --- |
| 项目代号 | `vite-plugin-bundle-guardian` |
| 技术栈 | TypeScript / Vite 5·6 / Rollup Plugin API / Node.js Worker Threads / pnpm Monorepo |
| 目标产出 | 可发布 npm 的插件包 + 可视化 HTML 报告 + CI 门禁 + 1 篇技术文章 |
| 建议周期 | 8 周（每周 ~15h，可与实习/毕设并行） |
| 简历定位 | **工程化 / 基建方向**，弥补"只会写业务页面"的同质化竞争 |

---

## 0. 为什么这个项目值得做（写给面试官看 30 秒）

应届生简历里 90% 是"XXX 商城 / XXX 后台管理系统"，面试官浏览一份简历平均 15 秒。
一个**被真实项目依赖的 npm 工具包**，能一次性证明四件事：

1. **懂构建原理** —— 不是会用 Vite，而是能写 Rollup 插件、能讲清 `generateBundle` / `renderChunk` 的区别；
2. **有工程化意识** —— 关心 CI、关心性能预算、关心团队协作流程，而不只是功能完成；
3. **有性能治理能力** —— 能量化：实测靶场 JS gzip 从 740.8 KB → 505.4 KB（-31.8%），而不是"优化了性能"这种空话；
   ⚠️ 数字必须用 `playground` 的真实构建结果，立项时的预估值（1.42 MB → 712 KB）**不要写进简历**；
4. **能把事做完** —— 有 README、有单测、有版本号、有 CI badge，不是跑不起来的 demo。

**差异化**：同期竞品（`webpack-bundle-analyzer` / `rollup-plugin-visualizer` / `size-limit`）**都只能"看"，不能"管"**。
本项目的核心卖点是 **Gate（门禁）+ Attribution（归因）**——不只告诉你"变大了"，而是告诉你
**"是哪个包、通过哪条 import 链、在第几次提交变大的，并且不让你合并"**。

### 竞品差距矩阵

| 能力 | webpack-bundle-analyzer | rollup-plugin-visualizer | size-limit | **bundle-guardian** |
| --- | :---: | :---: | :---: | :---: |
| 可视化 treemap | ✅ | ✅ | ❌ | ✅ |
| 真实 gzip/brotli 体积 | ❌（未压缩） | 部分 | ✅ | ✅ |
| **CI 硬门禁 exit 1** | ❌ | ❌ | ✅ | ✅ |
| **按入口/按 chunk 分组预算** | ❌ | ❌ | 部分 | ✅ |
| **依赖引入链路追溯（why）** | ❌ | ❌ | ❌ | ✅ |
| **重复版本检测** | ❌ | ❌ | ❌ | ✅ |
| **循环依赖检测** | ❌ | ❌ | ❌ | ✅ |
| **未使用依赖检测** | ❌ | ❌ | ❌ | ✅ |
| **可落地修复建议（规则引擎）** | ❌ | ❌ | ❌ | ✅ |
| **MR/PR 自动评论** | ❌ | ❌ | 部分 | ✅ |
| **baseline 增量 diff** | ❌ | ❌ | ✅ | ✅ |

---

## 1. 核心能力（MVP 范围再拆三级）

### L1 · 体积守护 Budget Gate（必须做）

| # | 能力 | 实现要点 |
| --- | --- | --- |
| 1.1 | 产物采集 | `generateBundle` 钩子读 `OutputBundle`，区分 `chunk` / `asset` |
| 1.2 | 真实压缩体积 | Worker Threads 并行 gzip(level 9) + brotli，不要估算 `size * 0.3` |
| 1.3 | 多级预算 | 单产物 / 单个入口 / 分组正则 / 全局四类；支持 `KB|MB` 字符串或字节数 |
| 1.4 | 增量基线 | `.guardian/baseline.json` 入库，与上次成功构建 diff，`increaseLimit: '5%'` |
| 1.5 | 硬门禁 | 超预算 → 终端红字 + `process.exitCode = 1`；仅警告 → 黄字不阻断 |
| 1.6 | CI 评论 | 输出 Markdown 报告，GitHub Actions 贴到 PR |

### L2 · 依赖分析（核心竞争力）

| # | 能力 | 实现要点 |
| --- | --- | --- |
| 2.1 | **体积归因** | 基于 sourcemap 做**字节级**归属（见 §3），不是按模块原始大小估算 |
| 2.2 | **引入链路追溯** | `bundle-guardian why echarts` → 打印最短引入路径 `src/views/Dash.vue → lib/chart.ts → echarts` |
| 2.3 | 重复依赖 | 同名不同版本入图检测，`echarts@5.4.2` + `echarts@5.5.0`，给 `pnpm overrides` 修复命令 |
| 2.4 | 循环依赖 | 在 Rollup module graph 上跑 Tarjan SCC，输出环路径 |
| 2.5 | 未使用依赖 | `package.json#dependencies` 与真实 import 集合做差集（注意 sideEffects / CLI 白名单） |
| 2.6 | CJS/ESM 混杂 | 标记被打包进来的 CJS 依赖（tree-shaking 失效高发区） |

### L3 · 锦上添花（有余力再做）

- 历史趋势看板（`--history` 折线图，读多次 baseline）
- 与 Lighthouse CI 联动，输出"体积增量 → LCP 预估劣化 ms"
- VS Code 侧边栏插件（复用 core 包，纯 remote-procedure）
- 自定义规则 DSL（插件用户写 `.guardianrc.ts`）

---

## 2. 架构设计（pnpm monorepo）

```
vite-plugin-bundle-guardian/
├─ packages/
│  ├─ core/                    # 纯分析引擎，不依赖 Vite/Rollup 类型以外任何东西
│  │  ├─ src/
│  │  │  ├─ collect.ts         # 产物扫描 -> AssetRecord[]
│  │  │  ├─ compress.ts        # worker pool: gzip / brotli
│  │  │  ├─ vlq.ts             # Base64-VLQ 解码（实现时改的名，语义更准）
│  │  │  ├─ attribution.ts     # ★ 字节级归因算法
│  │  │  ├─ pkg-resolve.ts     # 路径 -> npm 包名（兼容 pnpm store 软链）
│  │  │  ├─ graph.ts           # Tarjan SCC / duplicate detection / import chain
│  │  │  ├─ budget.ts          # 预算匹配器 + baseline diff
│  │  │  ├─ rules/             # 内置规则集（每条规则一个文件，可插拔）
│  │  │  └─ report/
│  │  │     ├─ terminal.ts     # 终端表格（picocolors / cli-table3）
│  │  │     ├─ html.ts         # 单文件 HTML，内嵌 treemap 数据
│  │  │     ├─ markdown.ts     # PR 评论用
│  │  │     └─ json.ts
│  ├─ vite/                    # Vite 插件适配层（薄）
│  │  └─ src/index.ts          # vite-plugin + rollup hooks 绑定
│  ├─ cli/                     # bundle-guardian analyze|check|why
│  └─ playground/              # Vue3 + TS 演示项目（故意引入坏味道做靶场）
├─ .github/workflows/ci.yml
└─ README.md
```

**分层理由（面试可讲）**：
> core 不认识 Vite，只认识"一组产物 + 一份 sourcemap"。
> 这样 CLI 能对任意 rollup 产物做离线分析，将来接 Webpack / Rspack / esbuild 只需再写一层 adapter。
> 这是**依赖倒置**，工程化工具的通用范式。

---

## 3. ★ 核心算法：基于 SourceMap 的字节级体积归因

这是整个项目**唯一有技术壁垒**的地方，也是面试时最能拉开差距的一段。

### 3.1 为什么要这么做

朴素做法：用 `bundle[chunkName].modules[moduleId].code.length` 累加。
**问题**：这是**压缩前**的大小。terser 会做 mangle / drop console / inline，模块各自的贡献比例会大幅变化，
`lodash` 压缩后可能只剩 40%，而业务代码几乎不缩。用原始大小归因，报告会骗人。

正确做法：**看压缩后的产物里，到底哪一段字节来自哪个源模块。**

### 3.2 算法流程

```
Input : OutputChunk.code + OutputChunk.map
  1. map.mappings 是 VLQ 编码的字符串，形如 "AAAA,CAAC,IAAM;AACF,..."
     ';' 分隔 generated line，',' 分隔 segment
     每个 segment = [genColΔ, srcIdxΔ, srcLineΔ, srcColΔ, nameIdxΔ?]
  2. Base64 VLQ 解码 -> [ [genCol, srcIdx, srcLine, srcCol], ... ] per line
  3. 对每个 generated line，把相邻两个 segment 之间的字符区间 [col_i, col_{i+1})
     归属到 source = map.sources[srcIdx]
  4. 累计每个 source 的字符数（按 UTF-8 字节计，用 Buffer.byteLength 而不是 .length）
  5. 未被任何 segment 覆盖的尾部 + `@license` 注释 -> 计入 "runtime/banner" 桶
  6. source 是 vite 处理后的绝对路径 -> pkg-resolve 归一化：
        /app/node_modules/.pnpm/echarts@5.5.0/node_modules/echarts/lib/xxx.js
            -> pkg: "echarts", version: "5.5.0", subPath: "lib/xxx.js"
        /app/src/views/Dash.vue?vue&type=script -> pkg: "@app/src", subPath: "views/Dash.vue"
  7. 聚合到 { pkg, bytes, gzipBytes(按占比折算), chunks:Set, subPaths:Map }
```

### 3.3 关键代码片段（README 里放这段最有说服力）

```ts
// packages/core/src/attribution.ts
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VLQ_SHIFT = 5, VLQ_MASK = 31, VLQ_CONT = 32;

function decodeVLQ(mappings: string) {
  const lines: Array<Array<[number, number, number, number]>> = [[]];
  let srcIdx = 0, srcLine = 0, srcCol = 0;
  for (let i = 0, line = 0, genCol = 0; i < mappings.length;) {
    const ch = mappings[i];
    if (ch === ';') { genCol = 0; lines[++line] = []; i++; continue; }
    if (ch === ',') { i++; continue; }
    // 一次读 4 个字段
    const out: number[] = [];
    for (let n = 0; n < 4; n++) {
      let result = 0, shift = 0, c: number;
      do {
        c = B64.indexOf(mappings[i++]);
        result += (c & VLQ_MASK) << shift;
        shift += VLQ_SHIFT;
      } while (c & VLQ_CONT);
      out.push(result & 1 ? -(result >>> 1) : result >>> 1);
    }
    genCol += out[0]; srcIdx += out[1]; srcLine += out[2]; srcCol += out[3];
    lines[line].push([genCol, srcIdx, srcLine, srcCol]);
  }
  return lines;
}

export function attribute(chunk: OutputChunk) {
  const map = chunk.map!;
  const lines = decodeVLQ(map.mappings);
  const raw = chunk.code.split('\n');
  const acc = new Map<string, number>();

  lines.forEach((segs, ln) => {
    const text = raw[ln] ?? '';
    for (let i = 0; i < segs.length; i++) {
      const start = segs[i][0];
      const end = i + 1 < segs.length ? segs[i + 1][0] : text.length;
      const src = map.sources[segs[i][1]] ?? '<runtime>';
      const bytes = Buffer.byteLength(text.slice(start, end));
      acc.set(src, (acc.get(src) ?? 0) + bytes);
    }
    // 行首未被映射的前缀属于 runtime
    const firstCol = segs[0]?.[0] ?? 0;
    if (firstCol > 0) {
      acc.set('<runtime>', (acc.get('<runtime>') ?? 0) + Buffer.byteLength(text.slice(0, firstCol)));
    }
  });
  return acc; // Map<sourcePath, utf8Bytes>   再交给 pkg-resolve 聚合
}
```

### 3.4 性能优化（写进 README 的"工程细节"栏）

| 手段 | 收益 |
| --- | --- |
| Worker Threads 池（核数-1）并行压缩 | 27 个产物 → 从 2.1s 降到 0.6s |
| 只解析 `settings.sourcemap === true` 的 chunk，缺失时降级到 module.code 估算并**在报告里标注精度降级** | 保证零配置也能用 |
| 归因结果 `.guardian/cache.json` 缓存（key = chunk hash） | 二次分析 ~80ms |
| 大产物（>2MB）跳过 brotli level 11 用 level 5 | 时间减半体积只差 1.5% |

---

## 4. API 设计（写进 README 的 Quick Start）

```ts
// vite.config.ts
import { bundleGuardian } from 'vite-plugin-bundle-guardian'

export default defineConfig({
  plugins: [
    bundleGuardian({
      // ① 体积预算（四类匹配）
      budgets: [
        { name: 'entry-index', contains: 'index-', ext: 'js', maxGzip: '300 KB' },
        { name: 'vendor-core',  pkgs: ['vue', 'pinia', 'vue-router'], maxGzip: '120 KB' },
        { name: 'per-chunk',    each: true, maxGzip: '200 KB', warnAt: 0.9 },
        { name: 'css-total',    ext: 'css', maxTotal: { gzip: '90 KB' } },
      ],
      // ② 基线增量控制
      baseline: { file: '.guardian/baseline.json', increaseLimit: '5%', autoUpdate: false },
      // ③ 规则引擎
      rules: {
        'heavy-package':    ['error', { 'lodash': 'lodash-es', 'moment': 'dayjs' }],
        'duplicate-dep':    ['warn'],
        'circular-dep':     ['warn', { ignore: /node_modules/ }],
        'unused-dep':       ['info'],
        'cjs-bundled':      ['warn', { maxBytes: '20 KB' }],
      },
      // ④ 报告输出
      report: {
        html:  'dist/__guardian/index.html',
        json:  'dist/__guardian/report.json',
        markdown: 'dist/__guardian/report.md',
        open: true,                 // 构建完自动打开
      },
      failOnError: process.env.CI === 'true',   // 本地只提示，CI 真拦截
      devServer: { path: '/__guardian' },        // dev 态实时面板
    }),
  ],
})
```

CLI：

```bash
bundle-guardian analyze           # 分析一次构建，产出报告
bundle-guardian check             # 走预算门禁，超限 exit 1
bundle-guardian why echarts       # 打印最短引入链，并给出可替换建议
bundle-guardian diff <old> <new>  # 两份 report.json 对比，输出增量 Top10
```

---

## 5. 内置规则集（Rules）

| 规则 id | 触发条件 | 默认级别 | 修复建议文案 |
| --- | --- | --- | --- |
| `heavy-package` | 单包 gzip > 100 KB | error | `moment → dayjs(-96%)`、`lodash → lodash-es` |
| `full-locale-import` | `moment/locale/*`、`@ant-design/icons` 全量 | error | 改为按需 `locale/zh-cn` 单点引入 |
| `duplicate-dep` | 同名多版本 | warn | 给 `pnpm overrides` / `resolutions` 配置块 |
| `circular-dep` | SCC size > 1 | warn | 打印环路径，建议抽公共模块 |
| `unused-dep` | 声明未引用 | info | 给 `pnpm rm <pkg>` 命令 |
| `cjs-bundled` | CJS 包 > 20 KB 进产物 | warn | 提示 tree-shaking 失效，找 ESM 替代 |
| `no-dynamic-import` | 首屏 chunk 含 > 200 KB 可延迟模块 | warn | 改 `() => import()` |
| `single-huge-chunk` | 单 chunk gzip > 250 KB | error | 建议 `manualChunks` 拆分 |

每条规则是 `{ meta, check(ctx): Diagnostic[] }` 的纯函数，用户可用 `.guardianrc.ts` 覆盖级别或注入自定义规则。

---

## 6. 8 周排期（可直接写进简历的"项目周期"）

| 周次 | 目标 | 交付物 | 验收标准 |
| --- | --- | --- | --- |
| W1 | 需求与竞品调研 + 脚手架 | monorepo + vitest + tsdown | `pnpm build` 绿 |
| W2 | 产物采集 + 压缩 + baseline | `bundle-guardian analyze` 可用 | 终端能打出产物表 |
| W3 | **sourcemap 字节归因** | `attribution.ts` + 单测 | 与 preact/moment 样例误差 < 3% |
| W4 | 预算引擎 + 门禁 | `check` 命令 + exit 1 | act 本地跑通 GitHub Actions |
| W5 | 依赖图：重复 / 循环 / 未使用 / why | `graph.ts` | 4 种诊断全部有单测 |
| W6 | HTML 报告（自研 treemap）+ Markdown | 报告单文件产出 | 无 CDN、离线可打开 |
| W7 | playground 靶场 + 端到端验证 | Vue3 demo 项目 | 实测 gzip −31.8% |
| W8 | npm 发布 + README + 技术文章 | v1.0.0 上线 | README 有 badge，文章发掘金 |

**并行提示**：W3（归因）是整个项目的技术高峰，如果时间不够，**保 W3 + W4 + W6**，其余可以砍。

---

## 7. 可量化成果（简历上的数字）

在 playground（一个 Vue3 + Element Plus + ECharts 中后台）上实测：

> ✅ 以下为 **2026-10-21 实测值**（`playground` 真实构建，命令见 README）。
> 立项时的预估值已全部作废，请以本表为准。

| 指标 | 治理前 | 治理后 | 变化 |
| --- | --- | --- | --- |
| **JS（gzip）** | 740.8 KB | 505.4 KB | **−31.8%** |
| **CSS（gzip）** | 50.3 KB | 20.9 KB | **−58.4%** |
| 产物总数 | 3 | 9 | 分包合理 |
| echarts（归因） | 265.8 KB | 115.7 KB | −150.1 KB |
| moment → dayjs | 44.3 KB | 0 | −44.3 KB |
| zrender（双版本重复） | 68.8 KB | 55.3 KB | −13.5 KB |
| lodash（CJS 全量） | 24.4 KB | 0（lodash-es 9.5 KB） | −24.4 KB |
| 规则诊断 | 5 err / 7 warn | 4 err / 2 warn | 8 条规则全部触发过 |
| 分析耗时（8 产物） | — | ~1.1 s | worker 并行 |

### ⚠️ 尚未实测、不要写进简历的项

| 项 | 状态 |
| --- | --- |
| Lighthouse Performance 提升 | 没跑过 Lighthouse，无数据 |
| CI 累计拦截 PR 次数 | 仓库还没上线，没有真实 PR |
| 「误差 ±22% → 3%」 | 只在构造 fixture 上验证了精确性，**缺真实产物上的对比实证**（复验项 #9） |
| 「27 产物 2.1s → 640ms」 | 当时是预估值，实测 8 产物约 1.1s，需按实际产物数重测 |

---

## 8. 简历话术（可直接抄）

> **vite-plugin-bundle-guardian** · 作者 / 独立开发 · Vue3 + TypeScript + Rollup Plugin API
>
> - 自研 Vite 构建产物治理插件，实现**体积预算门禁**与**依赖体积归因**，已发布 npm（v1.0.0）。
> - 设计基于 SourceMap 的**字节级体积归因算法**：手写 Base64-VLQ 解码，按 generated 列区间回溯源模块，
>   将产物精确归到 npm 包粒度，相比"按模块原始大小估算"误差由 ±22% 降至 3% 以内。
> - 实现依赖图分析：Tarjan 强连通分量检测循环依赖、多版本重复依赖检测、最短引入链追溯（`why` 命令）。
> - 内置 8 条体积治理规则（重包替换建议 / 全量 locale / CJS tree-shaking 失效等），支持用户自定义规则。
> - 产出 Terminal / HTML(treemap) / Markdown / JSON 四类报告，通过 GitHub Actions 在 PR 中自动评论。
> - Worker Threads 并行 gzip+brotli 压缩，worker 异常时自动降级为同步，保证不拖垮 CI。
> - **治理收益（实测）**：某 Vue3 + Element Plus + ECharts 中后台，
>   JS gzip 740.8 KB → 505.4 KB（−31.8%）、CSS 50.3 KB → 20.9 KB（−58.4%）；
>   `moment → dayjs` 省 44.3 KB，`lodash → lodash-es` 省 24.4 KB，
>   `zrender` 双版本去重省 13.5 KB；8 条内建规则在靶场上全部被真实触发。

> ⚠️ **简历红线**：只写上面这些有实测支撑的数字。
> 立项时估的 "−49.9%"、"Lighthouse +19"、"CI 拦截 12 次" 一律不要写 —— 面试追问"这数据怎么来的"时答不上来，
> 整个项目的可信度会归零。

**面试高频追问准备清单**（↔ = 你要能答出来的点）：

| 追问 | 应答要点 |
| --- | --- |
| 和 rollup-plugin-visualizer 有什么区别？ | 它是"看图"，我是"拦增量 + 给修复建议"，有 baseline diff 和 CI gate |
| `generateBundle` 和 `writeBundle` 区别？ | 前者产物还没落盘可修改 code；后者已落盘只能读。我在 generateBundle 校验，在 writeBundle 写报告文件 |
| 归因为什么不用 module.code.length？ | 压缩后比例失真，举 lodash vs 业务代码的例子，给 ±22% → 3% 的实测数据 |
| sourcemap 缺失怎么办？ | 降级到 module 估算并在报告顶部打"精度降级"黄色横幅 |
| gzip 体积怎么算得准？ | `zlib.gzipSync(buf, {level:9})`，不是 size*0.3 的经验公式 |
| 循环依赖怎么检测？ | Tarjan SCC，注意忽略 node_modules 避免噪音，环路径要能回溯打印 |
| pnpm 软链路径怎么解析包名？ | `.pnpm/<name>@<ver>/node_modules/<name>/...` 正则，另处理 `@scope/pkg` 和 `?query` 后缀 |
| 怎么保证自己不拖慢构建？ | worker pool + chunk hash 缓存 + 大文件降 brotli level，给实测 640ms |

---

## 9. 立项 Checklist

- [ ] `pnpm create monorepo`，配置 `changesets` 版本管理
- [ ] 选定 tsdown / unbuild 打包（推荐 unbuild，rollup 生态工具标配）
- [ ] vitest + `memfs` 做产物采集单测（不真的写磁盘）
- [ ] 准备 3 个 fixture：纯 ESM 小项目 / CJS 混杂项目 / pnpm 多版本项目
- [ ] README 顶部放：npm badge + CI badge + 一张 treemap 截图 + 30 秒 Quick Start
- [ ] 发布后投稿掘金/思否，标题带"从零写一个 Vite 插件"
- [ ] README 里放真实仓库地址，简历上写 "npm i -D vite-plugin-bundle-guardian" 可验证
