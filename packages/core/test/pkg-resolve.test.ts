import { describe, expect, it } from 'vitest';
import { resolveSource } from '../src/pkg-resolve.js';

describe('resolveSource · 包名归一化', () => {
  it('npm 扁平布局', () => {
    const r = resolveSource('/app/node_modules/lodash/merge.js');
    expect(r.pkg).toBe('lodash');
    expect(r.subPath).toBe('merge.js');
    expect(r.kind).toBe('npm');
  });

  it('npm 嵌套布局取最内层', () => {
    const r = resolveSource('/app/node_modules/a/node_modules/lodash/merge.js');
    expect(r.pkg).toBe('lodash');
  });

  it('识别 pnpm store 的版本号', () => {
    const r = resolveSource(
      '/app/node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/merge.js'
    );
    expect(r.pkg).toBe('lodash');
    expect(r.version).toBe('4.17.21');
  });

  it('scope 包把两段都取出来（pnpm 的 + 号要还原成 /）', () => {
    const r = resolveSource(
      '/app/node_modules/.pnpm/@babel+runtime@7.24.0/node_modules/@babel/runtime/helpers/esm/x.js'
    );
    expect(r.pkg).toBe('@babel/runtime');
    expect(r.version).toBe('7.24.0');
    expect(r.subPath).toBe('helpers/esm/x.js');
  });

  it('scope 包在扁平布局下也正确', () => {
    const r = resolveSource('/app/node_modules/@vueuse/core/index.mjs');
    expect(r.pkg).toBe('@vueuse/core');
    expect(r.subPath).toBe('index.mjs');
  });

  it('Windows 反斜杠路径同样能解析', () => {
    const r = resolveSource('C:\\proj\\node_modules\\axios\\index.js');
    expect(r.pkg).toBe('axios');
  });

  it('Vite 的 query 后缀要剥掉', () => {
    const r = resolveSource('/app/src/App.vue?vue&type=script&lang.ts');
    expect(r.kind).toBe('app');
    expect(r.pkg).toBe('@app');
    expect(r.subPath).toBe('/app/src/App.vue');
  });

  it('root 参与计算相对路径', () => {
    const r = resolveSource('/app/src/views/Dash.vue', { root: '/app' });
    expect(r.subPath).toBe('src/views/Dash.vue');
  });

  it('Rollup / Vite 注入的垫片归到同一个桶', () => {
    expect(resolveSource('\0commonjsHelpers.js').pkg).toBe('<rollup-helpers>');
    expect(resolveSource('\0vite/preload-helper').pkg).toBe('<rollup-helpers>');
  });

  it('其他虚拟模块走 <virtual>', () => {
    expect(resolveSource('\0virtual:my-plugin').pkg).toBe('<virtual>');
  });

  it('空值归到 runtime 桶', () => {
    expect(resolveSource('').kind).toBe('runtime');
  });
});
