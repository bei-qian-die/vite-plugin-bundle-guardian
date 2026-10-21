/**
 * 配置文件加载
 *
 * 之前只有「把选项写死在 vite.config.ts」一条路，团队里没法共享一套预算规则。
 * 现在支持从配置文件读取，与内联选项合并（**内联优先**）。
 *
 * 查找顺序（命中第一个即停）：
 *   .guardianrc.json → .guardianrc.mjs → .guardianrc.cjs → guardian.config.json
 *
 * 为什么支持 .mjs / .cjs：预算里常有「根据入口动态算限额」的需求，
 * 纯 JSON 表达不了，给个逃生舱比逼着用户写插件强。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Budget, DiagnosticLevel, GuardianOptions } from './types.js';

export const CONFIG_FILE_NAMES = [
  '.guardianrc.json',
  '.guardianrc.mjs',
  '.guardianrc.cjs',
  'guardian.config.json',
] as const;

/** 找到配置文件就返回绝对路径，否则 null */
export function findConfigFile(root: string): string | null {
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 读取配置文件。
 * JSON 走同步读取；.mjs / .cjs 走动态 import（因此本函数是 async）。
 * 解析失败返回 null 而不是抛错 —— 配置文件写错不该让构建挂掉。
 */
export async function loadConfigFile(root: string): Promise<{
  file: string;
  options: Partial<GuardianOptions>;
} | null> {
  const file = findConfigFile(root);
  if (!file) return null;

  try {
    if (file.endsWith('.json')) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { file, options: normalize(raw) };
    }
    const mod = await import(pathToFileURL(file).href);
    return { file, options: normalize(mod.default ?? mod) };
  } catch {
    return null;
  }
}

/** 同步版本（插件 configResolved 钩子里不方便 await 时用） */
export function loadConfigFileSync(root: string): {
  file: string;
  options: Partial<GuardianOptions>;
} | null {
  const file = findConfigFile(root);
  if (!file || !file.endsWith('.json')) return null;
  try {
    return { file, options: normalize(JSON.parse(fs.readFileSync(file, 'utf8'))) };
  } catch {
    return null;
  }
}

/** 只保留认识的字段，避免用户手滑写进来的垃圾配置污染内部状态 */
function normalize(raw: unknown): Partial<GuardianOptions> {
  if (!raw || typeof raw !== 'object') return {};
  const input = raw as Record<string, unknown>;
  const out: Partial<GuardianOptions> = {};

  if (Array.isArray(input.budgets)) out.budgets = input.budgets as Budget[];
  if (input.baseline && typeof input.baseline === 'object') out.baseline = input.baseline as GuardianOptions['baseline'];
  if (input.rules && typeof input.rules === 'object') {
    out.rules = input.rules as Record<string, DiagnosticLevel | [DiagnosticLevel, unknown]>;
  }
  if (input.report && typeof input.report === 'object') out.report = input.report as GuardianOptions['report'];
  if (typeof input.failOnError === 'boolean') out.failOnError = input.failOnError;
  if (typeof input.minPackageBytes === 'number') out.minPackageBytes = input.minPackageBytes;
  if (typeof input.workers === 'number') out.workers = input.workers;
  if (typeof input.cache === 'boolean') out.cache = input.cache;
  if (typeof input.cacheDir === 'string') out.cacheDir = input.cacheDir;
  if (typeof input.root === 'string') out.root = input.root;
  if (input.devServer && typeof input.devServer === 'object') out.devServer = input.devServer as GuardianOptions['devServer'];

  return out;
}

/**
 * 合并「配置文件选项」与「内联选项」。
 *
 * 规则：
 *   - 标量：内联优先（用户显式传 undefined 也算没传）
 *   - budgets：两者拼接，按 name 去重（内联覆盖同名项）—— 团队基线 + 项目个性化
 *   - rules / report / baseline：浅合并
 */
export function mergeOptions(
  fromConfig: Partial<GuardianOptions>,
  inline: Partial<GuardianOptions>
): GuardianOptions {
  const merged: GuardianOptions = { ...fromConfig };

  for (const [key, value] of Object.entries(inline)) {
    if (value === undefined) continue;
    (merged as Record<string, unknown>)[key] = value;
  }

  merged.budgets = mergeBudgets(fromConfig.budgets, inline.budgets);
  merged.rules = { ...(fromConfig.rules ?? {}), ...(inline.rules ?? {}) };
  merged.report = { ...(fromConfig.report ?? {}), ...(inline.report ?? {}) };
  merged.baseline = { ...(fromConfig.baseline ?? {}), ...(inline.baseline ?? {}) };

  return merged;
}

function mergeBudgets(base?: Budget[], extra?: Budget[]): Budget[] | undefined {
  if (!base && !extra) return undefined;
  const map = new Map<string, Budget>();
  for (const b of base ?? []) if (b?.name) map.set(b.name, b);
  for (const b of extra ?? []) if (b?.name) map.set(b.name, b);
  return [...map.values()];
}
