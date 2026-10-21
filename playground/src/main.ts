import { createApp } from 'vue';
import App from './App.vue';
import { installUI } from '@ui';
// 放在 installUI 之后：设计 token 要能覆盖 Element Plus 的 CSS 变量
import './style.css';

const app = createApp(App);
installUI(app);
app.mount('#app');
