## 📦 Bundle Report ✅ — build 1792577253870

| Metric | Value |
| --- | --- |
| Total gzip | 834.2 KB |
| Total brotli | 738.4 KB |
| Assets | 2 |
| Analysis | 733 ms |

### 📊 Size attribution (Top 10, gzip)

| Package | Version | Gzip | Share | Suggestion |
| --- | --- | --- | --- | --- |
| `echarts` | 5.6.0 | 272.0 KB | 32.6% | 检查是否有更轻的替代实现 |
| `element-plus` | — | 262.0 KB | 31.4% | 检查是否有更轻的替代实现 |
| `zrender` | 5.6.1 | 96.3 KB | 11.5% | pnpm.overrides 锁定到 5.6.1 |
| `moment` | 2.31.0 | 45.4 KB | 5.4% | moment/locale/* 全量注入 → 只引 locale/zh-cn |
| `lodash` | 4.18.1 | 25.0 KB | 3.0% | — |
| `@vue/runtime-core` | 3.5.44 | 15.6 KB | 1.9% | — |
| `lodash-es` | 4.18.1 | 9.2 KB | 1.1% | — |
| `@element-plus/icons-vue` | — | 7.0 KB | 0.8% | 图标 dist 全量 → 改成单组件 import |
| `@sxzz/popperjs-es` | 2.11.8 | 6.7 KB | 0.8% | — |
| `@vue/reactivity` | 3.5.44 | 5.9 KB | 0.7% | — |

### 🩺 Diagnostics

- ❌ **single-huge-chunk** — assets/index-BT9_WJPB.js 单产物 gzip 784.1 KB，超出建议值 → 用 build.rollupOptions.output.manualChunks 按厂商/路由拆分
- ❌ **heavy-package** — echarts@5.6.0 占了 272.0 KB gzip → 检查是否有更轻的替代实现
- ❌ **heavy-package** — element-plus 占了 262.0 KB gzip → 检查是否有更轻的替代实现
- ❌ **full-locale-import** — moment 全量引入国际化的资源 → moment/locale/* 全量注入 → 只引 locale/zh-cn
- ❌ **full-locale-import** — @element-plus/icons-vue 全量引入国际化的资源 → 图标 dist 全量 → 改成单组件 import
- ⚠️ **duplicate-dep** — zrender 并存 2 个版本：5.6.1 / 5.4.4 → pnpm.overrides 锁定到 5.6.1
- ⚠️ **no-dynamic-import** — echarts（272.0 KB）落在首屏入口 chunk 里 → 改成 () => import() 懒加载，配合 prefetch
- ⚠️ **no-dynamic-import** — element-plus（262.0 KB）落在首屏入口 chunk 里 → 改成 () => import() 懒加载，配合 prefetch
- ⚠️ **circular-dep** — 检测到循环依赖（2 个模块） → 抽离公共模块 / 用依赖注入打破环

<sub>由 <code>vite-plugin-bundle-guardian</code> 生成 · 2026/10/21 18:07:33</sub>