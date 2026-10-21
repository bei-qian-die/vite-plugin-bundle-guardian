# @bundle-guardian/core

构建产物分析引擎：**基于 SourceMap 的字节级体积归因** + 依赖图分析 + 体积预算门禁。

零运行时依赖，不认识 Vite —— 只消费「一组产物 + 一份 sourcemap」，
所以同一个引擎既能服务 Vite 插件，也能服务 CLI 与将来的 Webpack / Rspack adapter。

```bash
npm i @bundle-guardian/core
```

```ts
import { analyze, renderTerminal, shouldFail } from '@bundle-guardian/core';

const result = await analyze({
  bundle,                       // Rollup OutputBundle
  options: {
    budgets: [{ name: 'entry', contains: 'index-', ext: 'js', maxTotal: '300 KB' }],
    rules: { 'heavy-package': ['error', { maxGzip: '100 KB' }] },
  },
  moduleGraph,                   // 可选，用于环检测与引入链追溯
  dependencies,                  // 可选，用于未使用依赖检测
});

console.log(renderTerminal(result));
process.exitCode = shouldFail(result, true) ? 1 : 0;
```

完整文档见仓库根目录的 [README](../../README.md)。
