/**
 * 云服务客户端 —— 整个应用只初始化这一次。
 *
 * Auth / Database / Storage / LLM 四个模块共用同一个 client 实例：
 * 登录后，共享的请求层会自动把当前会话带到 Database 和 Storage 请求上，
 * 数据层不需要为登录/登出/刷新写任何额外代码。
 *
 * endpoint 和 publishableKey 是必填项，且只能来自 publicConfig；
 * 不要依赖 SDK 的同源兜底，也不要硬编码成字面量。
 */

import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';
import { publicConfig } from './cloud-config.js';

export const cloud = createWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
  publishableKey: publicConfig.publishableKey
});
