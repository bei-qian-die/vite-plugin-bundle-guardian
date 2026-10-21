/**
 * ✅ 治理后：dayjs（API 与 moment 几乎一致，体积只有 1/20）
 * locale 只引 zh-cn 一个，插件也按需 extend
 */

import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

export function formatDate(input: Date | string | number, pattern = 'YYYY-MM-DD'): string {
  return dayjs(input).format(pattern);
}

export function fromNow(input: Date | string | number): string {
  return dayjs(input).fromNow();
}

export function addDays(input: Date | string | number, days: number): Date {
  return dayjs(input).add(days, 'days').toDate();
}
