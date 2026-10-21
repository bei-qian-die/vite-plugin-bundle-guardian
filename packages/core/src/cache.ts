/**
 * 归因结果缓存
 *
 * 一次 VLQ 解码 + 列区间切分，在大产物上能占到整个分析耗时的六成以上。
 * 但同一个 chunk 的内容在一次构建内是稳定的 ——
 * 用 `fileName + codeHash` 做 key 把归因结果落到磁盘，二次分析直接命中，跳过解码。
 *
 * 失效条件：产物内容变了（hash 变）、缓存文件损坏、工具版本升级（版本号写进缓存）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ChunkAttribution } from './attribution.js';

/** 缓存结构版本号：归因算法有破坏性变更时 +1，旧缓存自动失效 */
const CACHE_VERSION = 1;

interface CacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

interface CacheEntry {
  hash: string;
  totalBytes: number;
  runtimeBytes: number;
  degraded: boolean;
  /** Map 不能直接 JSON 化，存成 [source, bytes] 数组 */
  bySource: Array<[string, number]>;
}

/** 缓存里存的是「未经 resolve 的归因结果」，避免把 ResolvedSource 序列化进 JSON */
export interface CachedAttribution {
  fileName: string;
  totalBytes: number;
  runtimeBytes: number;
  degraded: boolean;
  bySource: Array<[string, number]>;
}

export function hashCode(code: string): string {
  return createHash('sha1').update(code).digest('hex').slice(0, 16);
}

export interface CacheOptions {
  /** 缓存目录，默认 .guardian */
  cacheDir?: string;
  /** 缓存文件名，默认 cache.json */
  fileName?: string;
}

export class AttributionCache {
  private readonly file: string;
  private data: CacheFile;
  private dirty = false;
  private hits = 0;
  private misses = 0;

  constructor(root: string, options: CacheOptions = {}) {
    const dir = path.resolve(root, options.cacheDir ?? '.guardian');
    this.file = path.join(dir, options.fileName ?? 'cache.json');
    this.data = this.load();
  }

  private load(): CacheFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as CacheFile;
      if (raw?.version !== CACHE_VERSION || !raw.entries) {
        return { version: CACHE_VERSION, entries: {} };
      }
      return raw;
    } catch {
      return { version: CACHE_VERSION, entries: {} };
    }
  }

  /**
   * 命中返回缓存的归因结果。
   * 注意 bySource 只存 [source, bytes] —— `resolved` 需要再跑一次 pkg-resolve，
   * 但那是纯字符串运算，比 VLQ 解码便宜得多，不值得进缓存。
   */
  get(chunk: { fileName: string; code: string }): CachedAttribution | null {
    const key = chunk.fileName;
    const hash = hashCode(chunk.code ?? '');
    const entry = this.data.entries[key];
    if (!entry || entry.hash !== hash) {
      this.misses++;
      return null;
    }
    this.hits++;
    return {
      fileName: key,
      totalBytes: entry.totalBytes,
      runtimeBytes: entry.runtimeBytes,
      degraded: entry.degraded,
      bySource: entry.bySource,
    };
  }

  set(chunk: { fileName: string; code: string }, attribution: ChunkAttribution): void {
    this.data.entries[chunk.fileName] = {
      hash: hashCode(chunk.code ?? ''),
      totalBytes: attribution.totalBytes,
      runtimeBytes: attribution.runtimeBytes,
      degraded: attribution.degraded,
      bySource: attribution.bySource.map((s) => [s.source, s.bytes]),
    };
    this.dirty = true;
  }

  /** 落盘。任何写入失败都静默忽略 —— 缓存不是关键路径 */
  save(): void {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data), 'utf8');
      this.dirty = false;
    } catch {
      /* 只读文件系统 / 权限问题：不缓存也能正常工作 */
    }
  }

  stats(): { hits: number; misses: number; size: number } {
    return {
      hits: this.hits,
      misses: this.misses,
      size: Object.keys(this.data.entries).length,
    };
  }

  clear(): void {
    this.data = { version: CACHE_VERSION, entries: {} };
    this.dirty = true;
  }
}
