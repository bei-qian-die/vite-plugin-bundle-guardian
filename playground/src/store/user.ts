/**
 * 故意制造的循环依赖：store/user ⇄ api/auth
 * 用来验证 bundle-guardian 的 Tarjan SCC 环检测能把它挖出来
 */

import { fetchProfile } from '../api/auth';

export const userState = {
  name: '',
  role: '',
  loaded: false,
};

export async function loadUser(): Promise<void> {
  const profile = await fetchProfile();
  userState.name = profile.name;
  userState.role = profile.role;
  userState.loaded = true;
}
