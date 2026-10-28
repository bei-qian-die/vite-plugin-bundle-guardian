/**
 * 云服务的 publicConfig —— 由 workbuddy_cloud_service 开通时返回，原样记录在这里。
 *
 * 官方明确说明这四个值是「可以放进前端源码」的：publishableKey 只用于标识是哪个
 * 应用，本身不带任何权限，服务端还会校验 Origin 精确匹配（所以换成别的域名会直接
 * 被拒，而不是被别人借用）。
 *
 * 环境 id、各类 provider 密钥都留在服务端，不会下发 —— 也不要试图去拿。
 * 如果某个方案需要前端持有长期密钥，那方案本身就是错的。
 */

export const publicConfig = {
  resourceId: 'wbcs_2MgPY272vhfRmvkjeeBGF',
  endpoint: 'https://qiu-portfolio.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_Ur0f7O0jSCKZv9RbUhvgGL_9VNhl0cR31Ri5D5GO5y2rRei3knKkANB'
} as const;
