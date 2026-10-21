/**
 * ✅ 治理后：只注册真正用到的组件，并按需引入各自的 css
 * （生产项目可再上 unplugin-vue-components 自动按需）
 */

import {
  ElButton,
  ElCard,
  ElCol,
  ElDatePicker,
  ElRow,
  ElTable,
  ElTableColumn,
  ElTag,
} from 'element-plus';

import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/card/style/css';
import 'element-plus/es/components/col/style/css';
import 'element-plus/es/components/date-picker/style/css';
import 'element-plus/es/components/row/style/css';
import 'element-plus/es/components/table/style/css';
import 'element-plus/es/components/table-column/style/css';
import 'element-plus/es/components/tag/style/css';

import type { App } from 'vue';

const components = [ElButton, ElCard, ElRow, ElCol, ElTable, ElTableColumn, ElTag, ElDatePicker];

export function installUI(app: App): void {
  for (const component of components) app.use(component);
}
