/**
 * 并行压缩度量（Worker Threads）
 *
 * 关键点：
 *  1. 用真实 zlib 压缩计算体积，**不用 size × 0.3 那种经验公式** ——
 *     不同内容的压缩率能差一倍以上，估算值会让预算门禁形同虚设。
 *  2. Worker 脚本用 `new Worker(code, { eval: true })` 内联注入，
 *     避免给打包器（unbuild / rollup）增加 worker 文件解析的负担。
 *  3. 大产物（> 2MB）把 brotli quality 从 11 降到 5：耗时减半而体积只差约 1.5%。
 *  4. 任何 Worker 异常（沙箱环境 / 资源限制）都会静默降级到同步计算，保证 CLI 不崩。
 */

import { Worker } from 'node:worker_threads';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import os from 'node:os';
import type { SizeSet } from './types.js';

/** 超过该体积的产物降低 brotli quality（单位字节） */
const BIG_FILE_THRESHOLD = 2 * 1024 * 1024;

const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const zlib = require('zlib');
const result = {};
for (const task of workerData.tasks) {
  const buf = Buffer.from(task.buf);
  const raw = buf.length;
  const quality = raw > ${BIG_FILE_THRESHOLD} ? 5 : 11;
  result[task.key] = {
    raw,
    gzip: zlib.gzipSync(buf, { level: 9 }).length,
    brotli: zlib.brotliCompressSync(buf, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality },
    }).length,
  };
}
parentPort.postMessage(result);
`;

function measureSync(buf: Buffer): SizeSet {
  const raw = buf.length;
  const quality = raw > BIG_FILE_THRESHOLD ? 5 : 11;
  return {
    raw,
    gzip: gzipSync(buf, { level: 9 }).length,
    brotli: brotliCompressSync(buf, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: quality },
    }).length,
  };
}

export interface MeasureInput {
  key: string;
  buf: Buffer;
}

/** 单条压缩（降级路径 & 小规模场景） */
export function measure(input: string | Buffer): SizeSet {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return measureSync(buf);
}

/**
 * 批量压缩。
 * @param inputs 待压缩项
 * @param workers worker 数，默认 min(cpus - 1, inputs.length)，最少 1
 */
export async function measureMany(
  inputs: MeasureInput[],
  workers?: number
): Promise<Map<string, SizeSet>> {
  const out = new Map<string, SizeSet>();
  if (inputs.length === 0) return out;

  const count = clampWorkers(inputs.length, workers);

  if (count <= 1 || inputs.length < 3) {
    for (const item of inputs) out.set(item.key, measureSync(item.buf));
    return out;
  }

  try {
    // 按索引轮转分片，避免某个 worker 分到所有大文件
    const buckets: MeasureInput[][] = Array.from({ length: count }, () => []);
    inputs.forEach((item, i) => buckets[i % count].push(item));

    const results = await Promise.all(
      buckets.filter((b) => b.length > 0).map((bucket) => runWorker(bucket))
    );
    for (const partial of results) {
      for (const [key, value] of Object.entries(partial)) {
        out.set(key, { raw: value.raw, gzip: value.gzip, brotli: value.brotli });
      }
    }
    return out;
  } catch {
    // 降级：同步重算，绝不因为度量失败让整个构建挂掉
    for (const item of inputs) out.set(item.key, measureSync(item.buf));
    return out;
  }
}

function clampWorkers(itemCount: number, workers?: number): number {
  if (workers && workers > 0) return Math.min(workers, itemCount);
  try {
    return Math.max(1, Math.min(os.cpus().length - 1, itemCount));
  } catch {
    return 1;
  }
}

interface WorkerPayload {
  [key: string]: { raw: number; gzip: number; brotli: number };
}

function runWorker(bucket: MeasureInput[]): Promise<WorkerPayload> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          tasks: bucket.map((t) => ({ key: t.key, buf: t.buf })),
        },
      });
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      void worker.terminate();
    };

    worker.on('message', (payload: WorkerPayload) => {
      done(() => resolve(payload));
    });
    worker.on('error', (err) => {
      done(() => reject(err));
    });
    worker.on('exit', (code) => {
      if (code !== 0) done(() => reject(new Error(`worker exited with code ${code}`)));
    });
  });
}
