/**
 * 产物采集：把 Rollup 的 OutputBundle 转成统一的 AssetRecord[]
 *
 * 这一层刻意保持"薄"——它只负责：
 *   ① 归一化 chunk / asset 两种形态
 *   ② 计算扩展名与入口标记
 *   ③ 批量压缩得到真实 gzip / brotli 体积
 * 体积归因与图算法都不在这里发生，属于纯函数层，方便单测。
 */

import { measureMany } from './compress.js';
import type { AssetExt, AssetRecord, Bundle, OutputItem } from './types.js';

const EXT_MAP: Record<string, AssetExt> = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'js',
  '.ts': 'js',
  '.css': 'css',
  '.map': 'map',
};

export function detectExt(fileName: string): AssetExt {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return 'other';
  return EXT_MAP[fileName.slice(dot).toLowerCase()] ?? 'other';
}

export function toBuffer(item: OutputItem): Buffer {
  if ((item as { source?: unknown }).source !== undefined) {
    const src = (item as { source: string | Uint8Array }).source;
    return typeof src === 'string' ? Buffer.from(src, 'utf8') : Buffer.from(src);
  }
  return Buffer.from((item as { code: string }).code ?? '', 'utf8');
}

export interface CollectOptions {
  /** 是否跳过 .map 文件纳入统计（默认 true，map 不计入体积预算） */
  excludeMap?: boolean;
  workers?: number;
}

export async function collectAssets(
  bundle: Bundle,
  options: CollectOptions = {}
): Promise<AssetRecord[]> {
  const { excludeMap = true, workers } = options;

  const entries = Object.entries(bundle);
  const inputs = [];
  const metas: Array<Omit<AssetRecord, 'size'>> = [];

  for (const [fileName, item] of entries) {
    const ext = detectExt(fileName);
    if (excludeMap && ext === 'map') continue;

    const buf = toBuffer(item);
    inputs.push({ key: fileName, buf });
    metas.push({
      fileName,
      kind: item.type === 'asset' ? 'asset' : 'chunk',
      ext,
      isEntry: Boolean((item as { isEntry?: boolean }).isEntry),
      imports: (item as { imports?: string[] }).imports,
      dynamicImports: (item as { dynamicImports?: string[] }).dynamicImports,
    });
  }

  const sizes = await measureMany(inputs, workers);

  return metas
    .map((meta) => {
      const size = sizes.get(meta.fileName) ?? { raw: 0, gzip: 0, brotli: 0 };
      return { ...meta, size };
    })
    .sort((a, b) => b.size.gzip - a.size.gzip);
}
