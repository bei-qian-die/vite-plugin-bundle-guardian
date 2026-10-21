/**
 * ❌ 坏味道：moment 全量 + 把所有 locale 一起打进来
 * 只用到一个 format / fromNow，却带进来 200KB+（其中 locale 占一大半）
 */

import moment from 'moment';
import 'moment/locale/zh-cn';
import 'moment/locale/en-gb';
import 'moment/locale/ja';
import 'moment/locale/ko';
import 'moment/locale/fr';

moment.locale('zh-cn');

export function formatDate(input: Date | string | number, pattern = 'YYYY-MM-DD'): string {
  return moment(input).format(pattern);
}

export function fromNow(input: Date | string | number): string {
  return moment(input).fromNow();
}

export function addDays(input: Date | string | number, days: number): Date {
  return moment(input).add(days, 'days').toDate();
}
