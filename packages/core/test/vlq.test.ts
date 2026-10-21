import { describe, expect, it } from 'vitest';
import { decodeMappings, encodeSegment, encodeVLQ } from '../src/vlq.js';

describe('Base64-VLQ 编解码', () => {
  it('单值的 zigzag 编码符合规范', () => {
    expect(encodeVLQ(0).join('')).toBe('A');
    expect(encodeVLQ(1).join('')).toBe('C');
    expect(encodeVLQ(-1).join('')).toBe('D');
    expect(encodeVLQ(16).join('')).toBe('gB');
    expect(encodeVLQ(-16).join('')).toBe('hB');
  });

  it('解码与规范示例一致', () => {
    // "AAAA" → 四个增量都是 0 → 绝对值为 [0,0,0,0]
    const lines = decodeMappings('AAAA');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([[0, 0, 0, 0]]);
  });

  it('正确处理增量累加：delta 累加后才得到绝对行列', () => {
    // 第 1 个 segment: [0,0,0,0]；第 2 个 segment 各字段 +1 → 用编码器生成避免手算错误
    const lines = decodeMappings([encodeSegment([0, 0, 0, 0]), encodeSegment([10, 1, 1, 1])].join(','));
    expect(lines[0]).toEqual([
      [0, 0, 0, 0],
      [10, 1, 1, 1],
    ]);
  });

  it('";" 换行时 generatedColumn 归零，其余状态跨行保持累加', () => {
    const lines = decodeMappings([encodeSegment([0, 0, 0, 0]), encodeSegment([1, 1, 1, 1])].join(';'));
    expect(lines).toHaveLength(2);
    // srcIdx/srcLine/srcCol 跨行继续累加，genCol 从本行的 0 重新起算
    expect(lines[1]).toEqual([[1, 1, 1, 1]]);
  });

  it('只有 genCol 的单字段 segment 表示“无源码映射”，应被跳过', () => {
    // 'C' = 单字段 segment（genCol delta = 1），它是 терser/esbuild 注入代码的标记，
    // 对体积归因没有贡献，不应进入结果 —— 这正是 runtime 桶存在的依据。
    const lines = decodeMappings('AAAA;C');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual([]);
  });

  it('round-trip：编码后解码应得到原值', () => {
    const cases: number[][] = [
      [0, 0, 0, 0],
      [12, 3, 7, 1],
      [128, 5, 0, 64],
      [1024, 1, 999, 3],
    ];
    let prev = [0, 0, 0, 0];
    const encoded: string[] = [];
    for (const abs of cases) {
      const delta = abs.map((v, i) => v - (encoded.length === 0 ? 0 : prev[i]));
      encoded.push(encodeSegment(delta));
      prev = abs;
    }
    const lines = decodeMappings(encoded.join(','));
    expect(lines[0]).toEqual(cases);
  });

  it('遇到非法字符应抛出明确错误', () => {
    expect(() => decodeMappings('AAA*')).toThrow(/非法/);
  });
});
