/**
 * Base64-VLQ 编解码
 *
 * SourceMap v3 的 `mappings` 字段是一串 VLQ（Variable Length Quantity）编码：
 *
 *   mappings = "line0Seg0,line0Seg1;line1Seg0,line1Seg1;..."
 *                                  ↑ ';' 分隔 generated 行
 *                      ↑ ',' 分隔同一行内的 segment
 *
 * 每个 segment 有 1 / 4 / 5 个字段，且全部是**相对上一个 segment 的增量**：
 *
 *   [0] generatedColumn  必填，相对于同一行上一个 segment（换行时归零）
 *   [1] sourceIndex      相对于上一个 segment
 *   [2] sourceLine       相对于上一个 segment
 *   [3] sourceColumn     相对于上一个 segment
 *   [4] nameIndex        可选，存在时说明该位置有一个符号名
 *
 * 单个 VLQ 数值的编码方式（小端 + 6bit 分组）：
 *   1. 先做 zigzag：value = n < 0 ? ((-n) << 1) | 1 : n << 1   ← 末位是符号位
 *   2. 每 5 bit 一组从低到高拆开，凑成 6 bit，最高位 (0x20) 为「还有后续」标志
 *   3. 用 Base64 字符表映射
 *
 * 例子：n = -1 → zigzag 3 → 只有一个 6bit 组 "3" → 字符 'D'
 *      n = 16  → zigzag 32 → 低 5 bit = 0 → digit 0 且还有后续 → 'A'，
 *                             高 5 bit = 1 → digit 1 → 'B'   ⇒ "AB"
 */

import type { Seg4 } from './types.js';

const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 反向查表，避免 decode 时每次做 indexOf */
const BASE64_LOOKUP: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64.length; i++) t[BASE64.charCodeAt(i)] = i;
  return t;
})();

const VLQ_SHIFT = 5;
const VLQ_MASK = 31; // 0b011111
const VLQ_CONT = 32; // 0b100000

const CH_SEMI = 59; // ';'
const CH_COMMA = 44; // ','

/** 把单个整数编码成 VLQ 字符串 */
export function encodeVLQ(value: number, out: string[] = []): string[] {
  // zigzag：负数也能用一个无符号整数序列表示
  let vlq = value < 0 ? (-value) << 1 | 1 : value << 1;
  do {
    let digit = vlq & VLQ_MASK;
    vlq >>>= VLQ_SHIFT;
    if (vlq > 0) digit |= VLQ_CONT;
    out.push(BASE64[digit]);
  } while (vlq > 0);
  return out;
}

/** 编码一整个 segment（自动处理字段数与省略尾随 0 的写法） */
export function encodeSegment(fields: number[]): string {
  // 尾随的 0 可以省略（source-map 规范允许），但为了自测简单起见保留全部字段
  return fields.map((f) => encodeVLQ(f).join('')).join('');
}

/**
 * 解码 mappings 字符串。
 *
 * @returns 每行一个数组，元素为 [genCol, srcIdx, srcLine, srcCol]。
 *          1 字段（未映射）的 segment 会被跳过 —— 它们对体积归因没有贡献。
 */
export function decodeMappings(mappings: string): SegmentsPerLine {
  const lines: SegmentsPerLine = [];
  let line: Seg4[] = [];
  lines.push(line);

  let genCol = 0;
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;

  const len = mappings.length;
  let i = 0;

  while (i < len) {
    const ch = mappings.charCodeAt(i);

    if (ch === CH_SEMI) {
      // 换行：generatedColumn 归零，其余状态跨行保持
      genCol = 0;
      i++;
      line = [];
      lines.push(line);
      continue;
    }
    if (ch === CH_COMMA) {
      i++;
      continue;
    }

    const fields: number[] = [];
    for (let n = 0; n < 5; n++) {
      let result = 0;
      let shift = 0;
      let continue_ = false;
      do {
        if (i >= len) throw new Error(`mappings 在第 ${lines.length} 行被截断`);
        const c = BASE64_LOOKUP[mappings.charCodeAt(i++)];
        if (c < 0) throw new Error(`非法的 Base64 字符: ${mappings[i - 1]}`);
        continue_ = (c & VLQ_CONT) !== 0;
        result += (c & VLQ_MASK) << shift;
        shift += VLQ_SHIFT;
      } while (continue_);

      const negative = (result & 1) === 1;
      result = result >>> 1;
      fields.push(negative ? -result : result);

      // 后面还有字段吗？没有就提前退出（判断 field 数量）
      if (i >= len) break;
      const nx = mappings.charCodeAt(i);
      if (nx === CH_SEMI || nx === CH_COMMA) break;
    }

    if (fields.length === 1) {
      // 只有 generatedColumn → 这段产物没有对应源码（inject / banner / 模板字符串）
      genCol += fields[0];
      continue;
    }

    genCol += fields[0];
    srcIdx += fields[1];
    srcLine += fields[2];
    srcCol += fields[3];

    line.push([genCol, srcIdx, srcLine, srcCol]);
  }

  return lines;
}

/** 每行 segment 列表 */
export type SegmentsPerLine = Seg4[][];

/** 便捷外层类型，避免调用方再引 types.ts */
export type { Seg4 } from './types.js';
