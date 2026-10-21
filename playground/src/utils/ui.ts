/**
 * ❌ 坏味道：Element Plus 全量注册 + 全量 CSS
 * 全量 CSS 就有 ~330 KB，全量 JS 更会直接把首屏顶爆。
 */

import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import type { App } from 'vue';

export function installUI(app: App): void {
  app.use(ElementPlus);
}
