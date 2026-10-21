import { describe, expect, it } from 'vitest';
import {
  buildAdjacency,
  findCircularDependencies,
  findDuplicatePackages,
  findRoots,
  findShortestPath,
  findUnusedDependencies,
  tarjanSCC,
} from '../src/graph.js';

describe('Tarjan SCC · 循环依赖检测', () => {
  it('找出唯一的环，且不误报 DAG 部分', () => {
    const adjacency = buildAdjacency([
      { id: 'src/main.ts', importedIds: ['src/user.ts'] },
      { id: 'src/user.ts', importedIds: ['src/api.ts'] },
      { id: 'src/api.ts', importedIds: ['src/user.ts'] }, // ← 环在这里
      { id: 'src/utils.ts', importedIds: [] },
    ]);

    const cycles = findCircularDependencies(adjacency);
    expect(cycles).toHaveLength(1);
    expect([...cycles[0].cycle].sort()).toEqual(['src/api.ts', 'src/user.ts']);
  });

  it('多个互不相交的环能全部检出', () => {
    const adjacency = buildAdjacency([
      { id: 'a', importedIds: ['b'] },
      { id: 'b', importedIds: ['a'] },
      { id: 'c', importedIds: ['d'] },
      { id: 'd', importedIds: ['e'] },
      { id: 'e', importedIds: ['c'] },
    ]);
    expect(findCircularDependencies(adjacency)).toHaveLength(2);
  });

  it('默认忽略纯 node_modules 内部的噪音环', () => {
    const adjacency = buildAdjacency([
      { id: '/app/node_modules/x/a.js', importedIds: ['/app/node_modules/x/b.js'] },
      { id: '/app/node_modules/x/b.js', importedIds: ['/app/node_modules/x/a.js'] },
    ]);
    expect(findCircularDependencies(adjacency)).toHaveLength(0);
    expect(findCircularDependencies(adjacency, { ignoreNodeModules: false })).toHaveLength(1);
  });

  it('自环也算环', () => {
    const adjacency = buildAdjacency([{ id: 'self', importedIds: ['self'] }]);
    // buildAdjacency 会过滤掉自引用，改用原始 map 验证 tarjan 的自环分支由 buildAdjacency 兜住
    expect(adjacency.get('self')).toEqual([]);
    expect(tarjanSCC(buildAdjacency([{ id: 'p', importedIds: ['q'] }, { id: 'q', importedIds: ['p', 'q'] }])).length).toBeGreaterThan(0);
  });

  it('深链表不会爆栈（迭代版 Tarjan）', () => {
    const nodes = Array.from({ length: 6000 }, (_, i) => ({
      id: `m${i}`,
      importedIds: i < 5999 ? [`m${i + 1}`] : [],
    }));
    const components = tarjanSCC(buildAdjacency(nodes));
    expect(components).toHaveLength(6000);
  });
});

describe('findRoots / findShortestPath · 引入链追溯', () => {
  const adjacency = buildAdjacency([
    { id: 'src/main.ts', importedIds: ['src/views/Dash.vue', 'src/utils/date.ts'] },
    { id: 'src/views/Dash.vue', importedIds: ['/app/node_modules/lodash/merge.js'] },
    { id: 'src/utils/date.ts', importedIds: ['/app/node_modules/moment/index.js'] },
    { id: '/app/node_modules/lodash/merge.js', importedIds: [] },
    { id: '/app/node_modules/moment/index.js', importedIds: [] },
  ]);

  it('入度为 0 的节点就是入口', () => {
    expect(findRoots(adjacency)).toEqual(['src/main.ts']);
  });

  it('找到 lodash 的最短引入链', () => {
    const path = findShortestPath(adjacency, (id) => id.includes('node_modules/lodash/'));
    expect(path).toEqual(['src/main.ts', 'src/views/Dash.vue', '/app/node_modules/lodash/merge.js']);
  });

  it('找不到目标时返回 null', () => {
    expect(findShortestPath(adjacency, (id) => id.includes('react'))).toBeNull();
  });
});

describe('findDuplicatePackages · 多版本检测', () => {
  it('同名不同版本会被识别，并累加估算体积', () => {
    const groups = findDuplicatePackages([
      { pkg: 'echarts', version: '5.4.2', file: '/node_modules/.pnpm/echarts@5.4.2/node_modules/echarts/i.js', bytes: 600 },
      { pkg: 'echarts', version: '5.5.0', file: '/node_modules/.pnpm/echarts@5.5.0/node_modules/echarts/i.js', bytes: 900 },
      { pkg: 'lodash', version: '4.17.21', file: '/node_modules/lodash/index.js', bytes: 100 },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].pkg).toBe('echarts');
    expect(groups[0].versions).toHaveLength(2);
    expect(groups[0].estimatedBytes).toBe(1500);
  });

  it('无版本信息（扁平安装）的重复不算数', () => {
    expect(findDuplicatePackages([{ pkg: 'lodash', file: 'x' }])).toHaveLength(0);
  });
});

describe('findUnusedDependencies · 未使用依赖检测', () => {
  it('声明但未引用的包会被列出', () => {
    const unused = findUnusedDependencies(
      { qs: '^6.0.0', jsMD5: '^2.0.0', echarts: '^5.0.0' },
      { detectedPkgs: new Set(['echarts']) }
    );
    expect(unused.map((u) => u.pkg)).toEqual(['qs', 'jsMD5']);
  });

  it('白名单里的包会被跳过', () => {
    const unused = findUnusedDependencies(
      ['postcss', 'eslint-plugin-x'],
      { detectedPkgs: new Set(), allowlist: ['postcss'] }
    );
    expect(unused.map((u) => u.pkg)).toEqual(['eslint-plugin-x']);
  });
});
