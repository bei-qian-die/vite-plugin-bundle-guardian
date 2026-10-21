/**
 * ❌ 坏味道：整个 lodash 打进产物（CJS 版 tree-shaking 基本无效）
 * 实际只用到 4 个方法，却付了整个库 71 KB 的钱
 */

import _ from 'lodash';

export function sortBy<T>(list: T[], key: string): T[] {
  return _.sortBy(list, key);
}

export function groupBy<T>(list: T[], key: string): Record<string, T[]> {
  return _.groupBy(list, key);
}

export function debounceFn<T extends (...args: never[]) => void>(fn: T, wait = 300) {
  return _.debounce(fn, wait);
}

export function deepClone<T>(value: T): T {
  return _.cloneDeep(value);
}
