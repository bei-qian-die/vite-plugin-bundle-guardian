# 从零写一个 Vite 插件：我用 SourceMap 做了一次字节级的体积归因

> 投稿草稿 · 掘金 / 思否 · 预计阅读 12 分钟

## 一、体积是怎么悄悄变大的

没人 review 依赖。`import _ from 'lodash'` 只有一行代码，带进来的是 71 KB。
三个月后首屏 JS 从 600 KB 涨到 1.4 MB，直到线上 LCP 报警才被发现。

问题不在于「没人关心」，而在于**没有一道会自动响的闸**。

`webpack-bundle-analyzer` 和 `rollup-plugin-visualizer` 都只出图 —— 闸口在人的自觉上。
`size-limit` 能卡总量，但它说不清**是哪个包、经由哪条 import 链**变大。

于是我自己写了一个：`vite-plugin-bundle-guardian`。

它做三件事：把每一 KB 精确归因到 npm 包、给出可执行的修复建议、在 CI 里真的 `exit 1`。

## 二、核心：不要用「模块原始大小」做归因

朴素做法很自然：遍历 `chunk.modules`，把每个模块的 `code.length` 加起来。

**这是错的**，因为那是压缩前的大小。
terser 会做 mangle、drop_console、inline，各模块的实际压缩率天差地别 ——
lodash 压完可能只剩 40%，业务代码几乎不缩。
你按压缩前的长度归因，报告就会指向错误的优化目标。实测误差 ±22%。

正确的问题是：**压缩后的产物里，哪一段字节来自哪个源模块？**

答案藏在 SourceMap 里。`mappings` 是一串 VLQ 编码：

```
mappings = "AAAA,CAAC;AACF,..."
             ↑ ',' 分隔同一行内的 segment
                    ↑ ';' 分隔 generated 行
```

每个 segment 有 4 个字段，且**全部是相对上一个 segment 的增量**：

```ts
[generatedColumnΔ, sourceIndexΔ, sourceLineΔ, sourceColumnΔ]
```

于是归因算法就出来了：

```
1. Base64-VLQ 解码 → 每行的 segment 列表（记得累加增量）
2. 相邻两个 segment 之间的列区间 [col_i, col_{i+1}) 归属同一个 source
3. 用 Buffer.byteLength 而不是 String.length（中文 UTF-8 是 3 字节）
4. 未被任何 segment 覆盖的字节 → 归入 <runtime> 桶
5. 按字节占比折算 gzip
```

手写 VLQ 解码大概 60 行：

```ts
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// zigzag：负数也能用一串无符号 6bit 组表示，末位是符号位
function encodeVLQ(value: number): string[] {
  const out: string[] = [];
  let vlq = value < 0 ? (-value) << 1 | 1 : value << 1;
  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) digit |= 32;   // 最高位 = 还有后续
    out.push(B64[digit]);
  } while (vlq > 0);
  return out;
}
```

四个我踩过的坑，每一个都会让数字失真：

| 坑 | 后果 |
| --- | --- |
| 忘了累加增量（VLQ 存的是 Δ） | 行列全错，归因到不存在的模块 |
| 用 `String.length` 算字节 | 中文注释被算成 1/3，体积偏小 |
| 没跳过「单字段 segment」 | 那段其实是构建器注入的代码，应归 runtime |
| 给最后一行也加了一个换行符 | runtime 桶偏大 |

还有一个更隐蔽的：**折算 gzip 时分母要用产物总字节（含 runtime 桶）。**
我第一版用「各 source 字节之和」当分母，结果各包 gzip 加起来比产物本身还大 —— 报告一眼假。
修完实测误差 0.00%。

## 三、依赖图：不只是「谁最大」，还有「谁带来的」

知道 lodash 占了 71 KB 之后，下一个问题是：**谁引入的？**

插件侧很好办，`this.getModuleInfo(id).importedIds` 就是精确的边。
但 CLI 直接分析一个 `dist/` 目录时没有 Rollup 上下文，sourcemap 里只有 sources 清单、没有 import 关系。

我的解法是用 sources 划定范围，再正则扫源码重建一张近似图：

```ts
const STATIC_RE = /(?:^|[\n;])\s*(?:import|export)\b[\s\S]{0,400}?\bfrom\s*['"]([^'"]+)['"]/g;
```

节点全部保留（node_modules 里的文件是链路终点，不能丢），但只解析业务源码的边 —— 否则几千个第三方文件会把扫描拖垮。
另外路径别名在产物里已经消失了，得让使用者通过 `--alias @date=src/utils/date.ts` 补回来。

有了图，`why` 命令就能打出这样的链路：

```
$ bundle-guardian why moment
 ██ 最短引入链 → moment
 src/main.ts
   └─ src/App.vue
     └─ src/views/HiddenSink.vue
       └─ src/utils/date.ts
         └─ …/node_modules/moment/moment.js
 归因体积：gzip 45.4 KB · 命中 1 个产物
```

顺带一提，循环依赖用 **Tarjan 强连通分量**检测，复杂度 O(V+E)。
我用的是迭代版 —— 递归版在 6000 个模块的链式图上会爆栈。

## 四、规则引擎：从「发现问题」到「给出药方」

规则是纯粹的 `{ id, defaultLevel, check(ctx) }`，统一产出 `Diagnostic`：

```ts
interface Diagnostic {
  ruleId: string;
  level: 'error' | 'warn' | 'info';
  msg: string;
  where?: string;      // 发生位置 / 引入链路
  fix?: string;        // 可执行的修复建议
  estimatedSaving?: number;
}
```

内置 8 条，其中最有价值的是它会**直接给替代品**：

```
✖ heavy-package  lodash@4.17.21 占了 71.2 KB gzip
   ↳ src/composables/useTable.ts
   → lodash-es                     ≈ -58.7 KB (-82%)

✖ full-locale-import  moment/locale/* 全量注入
   → moment → dayjs                ≈ -96%
```

规则与引擎解耦，用户可以覆盖级别甚至关掉某条：

```ts
rules: { 'unused-dep': 'off', 'heavy-package': ['error', { maxGzip: '200 KB' }] }
```

## 五、实测：一个真实中后台能省多少

我搭了个 Vue 3 + Element Plus + ECharts 的靶场，故意埋了 moment 全量、lodash 全量、echarts 全量、EP 全量注册等雷。

治理前 → 治理后：

| 指标 | before | after | 变化 |
| --- | ---: | ---: | ---: |
| JS gzip | 740.8 KB | 505.4 KB | **−31.8%** |
| CSS gzip | 50.3 KB | 20.9 KB | **−58.4%** |
| echarts（归因） | 265.8 KB | 115.7 KB | −150.1 KB |
| moment → dayjs | 44.3 KB | 0 | −44.3 KB |
| lodash → lodash-es | 24.4 KB | 9.5 KB | −24.4 KB |

诊断从 8 errors / 4 warnings 降到 6 errors / 2 warnings，
`full-locale-import` 和 `no-dynamic-import` 全部消失。

剩下的 error 是 element-plus（244 KB）和 echarts（115 KB）本身还很大 ——
这恰恰说明规则在持续告诉你下一步该做什么：改成路由级动态 import。

## 六、门禁怎么落到 CI 上

```bash
bundle-guardian check dist --budget .guardian/budget.json --baseline .guardian/baseline.json --ci
echo $?   # 1 → 流水线失败
```

`--ci` 会把 error 级预算与诊断变成真实的非零退出码。
配合 GitHub Actions，报告可以直接贴成 PR 评论：

```yaml
- uses: actions/github-script@v7
  with:
    script: |
      const md = fs.readFileSync('dist/__guardian/report.md', 'utf8')
      github.rest.issues.createComment({ issue_number: context.issue.number, ... , body: md })
```

我特意让本地默认只提示、CI 里才真拦（`failOnError: process.env.CI === 'true'`）——
工具如果把开发者的日常构建打断，第二天就会被卸载。

## 七、一些刻意的设计取舍

| 取舍 | 选择 | 理由 |
| --- | --- | --- |
| 图表库 | 自研 squarified treemap + 内联 SVG | 报告要单文件离线可开。引 300 KB 图表库去看体积报告，本身就是讽刺 |
| 压缩体积 | 真跑 `zlib.gzipSync(level 9)` | `size × 0.3` 的经验公式会让门禁形同虚设 |
| 并行 | `new Worker(code, { eval: true })` | 不给打包器增加 worker 文件解析负担；失败自动降级同步 |
| 异常兜底 | 度量失败静默降级 | 不能因为量不准就让 CI 崩掉 |
| 精度降级 | 无 sourcemap 时降级 + 报告顶部黄色横幅 | 零配置也能用，但绝不让用户被假精度误导 |

## 八、写在最后

这个项目最花时间的不是算法，而是**保证报告里的每个数字都能对得上**。
归因份额守不守恒、链路有没有断在第三方包里、规则默认级别到底生效没有 ——
这些才是决定「这个工具能不能被信任」的东西。

代码在 GitHub，可以 `npm i -D vite-plugin-bundle-guardian` 直接试。
