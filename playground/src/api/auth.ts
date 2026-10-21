/**
 * 循环依赖的另一端：这里又 import 回 store/user —— 形成环
 */

import { userState } from '../store/user';

export async function fetchProfile(): Promise<{ name: string; role: string }> {
  // 这里读 userState 制造反向依赖
  if (userState.loaded) return { name: userState.name, role: userState.role };
  return { name: '张三', role: 'admin' };
}
