/**
 * ✅ 治理后：lodash-es 按方法单点引入，rollup 能真正 tree-shake
 * 同样 4 个方法，体积从 71 KB 降到约 3 KB
 */

import sortByFn from 'lodash-es/sortBy';
import groupByFn from 'lodash-es/groupBy';
import debounce from 'lodash-es/debounce';
import cloneDeep from 'lodash-es/cloneDeep';

export function sortBy<T>(list: T[], key: string): T[] {
  return sortByFn(list, key);
}

export function groupBy<T>(list: T[], key: string): Record<string, T[]> {
  return groupByFn(list, key);
}

export function debounceFn<T extends (...args: never[]) => void>(fn: T, wait = 300) {
  return debounce(fn, wait);
}

export function deepClone<T>(value: T): T {
  return cloneDeep(value);
}
