/** node 内建模块在浏览器端的空实现占位 */
export default {};
export const readFileSync = () => '';
export const writeFileSync = () => {};
export const existsSync = () => false;
export const statSync = () => ({ size: 0, isFile: () => false, isDirectory: () => false });
export const readdirSync = () => [];
export const promises = {};
