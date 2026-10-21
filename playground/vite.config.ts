import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { bundleGuardian } from 'vite-plugin-bundle-guardian';

const root = path.dirname(fileURLToPath(import.meta.url));
const pick = (file: string) => path.resolve(root, 'src/utils', file);

/**
 * 靶场有两种模式，用来做 before / after 对比：
 *   before —— 体积坏味道全开（moment 全量 + locale、lodash 全量、echarts 全量、EP 全量注册）
 *   after  —— 治理后（dayjs、lodash-es 按需、echarts core 按需注册、EP 按需引入 + manualChunks）
 */
export default defineConfig(({ mode }) => {
  const optimized = mode === 'after';

  return {
    resolve: {
      alias: {
        '@date': pick(optimized ? 'date.after.ts' : 'date.ts'),
        '@helper': pick(optimized ? 'helper.after.ts' : 'helper.ts'),
        '@chart': pick(optimized ? 'echarts.after.ts' : 'echarts.ts'),
        '@ui': pick(optimized ? 'ui.after.ts' : 'ui.ts'),
      },
    },

    plugins: [
      vue(),
      bundleGuardian({
        budgets: [
          { name: 'entry-index', contains: 'index-', ext: 'js', maxTotal: '300 KB' },
          { name: 'per-chunk', each: true, maxGzip: '200 KB', warnAt: 0.9 },
          { name: 'vendor-ui', pkgs: ['element-plus', 'echarts'], maxTotal: '260 KB' },
        ],
        baseline: { file: optimized ? '.guardian/baseline-after.json' : '.guardian/baseline-before.json' },
        rules: { 'unused-dep': 'warn' },
        report: {
          html: `dist-${optimized ? 'after' : 'before'}/__guardian/index.html`,
          json: `dist-${optimized ? 'after' : 'before'}/__guardian/report.json`,
          markdown: `dist-${optimized ? 'after' : 'before'}/__guardian/report.md`,
        },
        failOnError: false, // 靶场只观测不拦截，CI 里才开
      }),
    ],

    build: {
      sourcemap: true, // 归因精度的来源，必须开
      outDir: optimized ? 'dist-after' : 'dist-before',
      chunkSizeWarningLimit: 1, // 关掉 vite 自己的提示，交给 guardian
      rollupOptions: optimized
        ? {
            output: {
              manualChunks(id) {
                if (id.includes('node_modules/echarts')) return 'echarts';
                if (id.includes('node_modules/element-plus')) return 'element-plus';
                if (id.includes('node_modules/moment') || id.includes('node_modules/dayjs')) return 'date';
                if (id.includes('node_modules/lodash')) return 'lodash';
                if (id.includes('node_modules/vue') || id.includes('node_modules/@vue')) return 'vue';
              },
            },
          }
        : {},
    },
  };
});
