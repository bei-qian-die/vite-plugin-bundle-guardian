/**
 * 测试辅助：构造可控的 chunk + sourcemap fixture
 */

import { encodeVLQ } from '../src/vlq.js';
import type { ChunkLike, SourceMapLike } from '../src/types.js';

export interface FakeSource {
  path: string;
  /** 该 source 在 generated 代码中贡献的文本（不含换行） */
  text: string;
}

/**
 * 生成一个 simplistic 的 chunk：
 *   generated 代码每一行完全来自一个 source，便于精确断言字节归属。
 * @param sources source 列表
 * @param extra 追加到产物末尾的「注入代码」（无映射），用于验证 runtime 桶
 */
export function makeSimpleChunk(sources: FakeSource[], extra = ''): ChunkLike {
  const code = sources.map((s) => s.text).join('\n') + (extra ? '\n' + extra : '');

  const mappings = sources
    .map((_, i) => {
      // segment = [genColΔ, srcIdxΔ, srcLineΔ, srcColΔ]
      // 我们让每个 source 独占一行，行内的 genCol 一律从 0 开始
      const fields = i === 0 ? [0, 0, 0, 0] : [0, 1, 0, 0];
      return fields.map((f) => encodeVLQ(f).join('')).join('');
    })
    .join(';');

  const map: SourceMapLike = {
    version: 3,
    sources: sources.map((s) => s.path),
    sourcesContent: sources.map((s) => s.text),
    names: [],
    mappings,
  };

  return {
    type: 'chunk',
    fileName: 'index.js',
    code,
    map,
    isEntry: true,
  };
}

/**
 * 生成「多 source 交织在同一行」的 chunk —— 更接近真实压缩产物：
 * 一行 minified 代码里，前 20 列来自 lodash、20~58 列来自 src/app.ts……
 * 这才是 sourcemap 归因真正要处理的形态，也是朴素 `module.code.length` 会算错的地方。
 *
 * @returns chunk 与「每个 source 期望被归因到的 UTF-8 字节数」
 */
export function makeInterleavedChunk(
  sources: FakeSource[],
  plan: number[]
): { chunk: ChunkLike; expected: Map<string, number> } {
  const pools = sources.map((s) => s.text);
  const cursors = sources.map(() => 0);
  const expected = new Map<string, number>();

  let genLine = '';
  let prevGenCol = 0;
  let prevSrcIdx = 0;
  const parts: string[] = [];

  plan.forEach((srcIdx, i) => {
    const take = Math.max(1, Math.floor(pools[srcIdx].length / 3));
    const text = pools[srcIdx].slice(cursors[srcIdx], cursors[srcIdx] + take);
    cursors[srcIdx] += take;

    // VLQ 存的都是相对上一个 segment 的增量
    const genCol = genLine.length;
    parts.push(
      [i === 0 ? 0 : genCol - prevGenCol, i === 0 ? srcIdx : srcIdx - prevSrcIdx, 0, 0]
        .map((f) => encodeVLQ(f).join(''))
        .join('')
    );
    prevGenCol = genCol;
    prevSrcIdx = srcIdx;

    genLine += text;
    const path = sources[srcIdx].path;
    expected.set(path, (expected.get(path) ?? 0) + Buffer.byteLength(text));
  });

  const map: SourceMapLike = {
    version: 3,
    sources: sources.map((s) => s.path),
    sourcesContent: sources.map((s) => s.text),
    names: [],
    mappings: parts.join(','),
  };

  return {
    chunk: { type: 'chunk', fileName: 'interleaved.js', code: genLine, map, isEntry: true },
    expected,
  };
}
