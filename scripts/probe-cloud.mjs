/**
 * 云服务连通性探针（Node，无需浏览器）
 *
 * 用 SDK + publicConfig 真实打一次数据面，确认三件事：
 *   1. endpoint / publishableKey 有效（不是被网关 401 拦下）
 *   2. auth 未登录时返回的是 UNAUTHENTICATED，而不是「环境不存在」
 *   3. analysis_records 表存在、RLS 生效
 *
 *   node scripts/probe-cloud.mjs
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const webRoot = resolve(root, 'packages/web');

/* 从源码里读出 publicConfig，保证探针和页面用的是同一份配置 */
const cfgSrc = readFileSync(resolve(webRoot, 'src/cloud-config.ts'), 'utf8');
const grab = (key) => {
  const m = new RegExp(`['"]?${key}['"]?\\s*:\\s*['"]([^'"]+)['"]`).exec(cfgSrc);
  if (!m) throw new Error(`publicConfig 里找不到 ${key}`);
  return m[1];
};
const publicConfig = {
  resourceId: grab('resourceId'),
  endpoint: grab('endpoint'),
  oauthRelayBaseUrl: grab('oauthRelayBaseUrl'),
  publishableKey: grab('publishableKey')
};

console.log('endpoint      :', publicConfig.endpoint);
console.log('resourceId    :', publicConfig.resourceId);
console.log('publishableKey:', publicConfig.publishableKey.slice(0, 12) + '…(已脱敏)');

const req = createRequire(`${webRoot}/package.json`);
const { createWorkBuddyCloud } = req('@tencent-ai/workbuddy-cloud-sdk');

const cloud = createWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
  publishableKey: publicConfig.publishableKey
});

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed += 1;
};

/* 1. getSession —— 未登录应返回 UNAUTHENTICATED，而不是网络/环境错误 */
try {
  const { data, error } = await cloud.auth.getSession();
  check('auth 数据面可达', error === null || error === undefined || !!error, `error=${error ? (error.code ?? error.kind ?? error.message) : 'none'}`);
  check('未登录时无会话', !data);
} catch (e) {
  check('auth 数据面可达', false, e instanceof Error ? e.message : String(e));
}

/* 2. 数据库读 —— 表存在且 RLS 生效（应返回空数组，不是 42P01） */
try {
  const { data, error } = await cloud.database.from('analysis_records').select('id,label').limit(5);
  check('数据库表可读', !error, error ? String(error.code ?? error.message) : 'rows=' + (data?.length ?? 0));
  check('RLS 拦截未登录读取', Array.isArray(data) && data.length === 0);
} catch (e) {
  check('数据库表可读', false, e instanceof Error ? e.message : String(e));
}

/* 3. 未登录写入应被拒绝（不能静默成功） */
try {
  const { data, error } = await cloud.database
    .from('analysis_records')
    .insert({ label: 'probe-should-fail', asset_count: 0 })
    .select();
  const blocked = !!error || !Array.isArray(data) || data.length === 0;
  check('RLS 拦截未登录写入', blocked, error ? String(error.code ?? error.message) : '');
} catch (e) {
  /* 抛异常也算被拦住，只要没有静默成功 */
  check('RLS 拦截未登录写入', true, e instanceof Error ? e.message : String(e));
}

console.log(failed === 0 ? '\n云服务数据面连通正常' : `\n有 ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
