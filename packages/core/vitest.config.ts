import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vite 的转换缓存默认落在系统 temp；某些受管环境下该目录会 EPERM，
  // 结果是测试文件被静默跳过、用例数莫名变少。固定在项目内可规避。
  cacheDir: './node_modules/.vite',
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
    testTimeout: 15000,
    cacheDir: './node_modules/.vitest-cache',
  },
});
