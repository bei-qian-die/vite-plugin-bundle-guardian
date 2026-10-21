# vite-plugin-bundle-guardian

构建产物治理插件：**体积守护 + 依赖分析**。
让「包体积失控」从**事后发现**变成**提交即拦截**。

```bash
npm i -D vite-plugin-bundle-guardian
```

```ts
// vite.config.ts
import { bundleGuardian } from 'vite-plugin-bundle-guardian';

export default defineConfig({
  build: { sourcemap: true },   // 归因精度的来源，务必开启
  plugins: [
    bundleGuardian({
      budgets: [{ name: 'entry-index', contains: 'index-', ext: 'js', maxTotal: '300 KB' }],
      failOnError: process.env.CI === 'true',
    }),
  ],
});
```

也可以把预算写进 `.guardianrc.json`，插件会自动读取并与内联选项合并（内联优先）。

核心差异：不是"看图"，而是**归因到包 + 给修复建议 + 在 CI 里真的 exit 1**。
实测某 Vue3 中后台 JS gzip 761.4 KB → 502.0 KB（−34.1%）。

完整文档见仓库根目录的 [README](../../README.md)。
