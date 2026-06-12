/**
 * 微信小程序 code → openid（登录 / 找回密码验证）
 */

export function isWechatMpLoginConfigured(env) {
  return !!(env.WECHAT_APP_ID && env.WECHAT_MINI_APP_SECRET);
}

export async function codeToSession(env, code) {
  const appId = env.WECHAT_APP_ID || '';
  const secret = env.WECHAT_MINI_APP_SECRET || '';
  if (!appId || !secret) return { error: '小程序登录未配置 WECHAT_MINI_APP_SECRET' };
  if (!code || typeof code !== 'string') return { error: '缺少微信 code' };

  const qs = new URLSearchParams({
    appid: appId,
    secret,
    js_code: code,
    grant_type: 'authorization_code',
  });
  const res = await fetch(`https://api.weixin.qq.com/sns/jscode2session?${qs}`);
  const data = await res.json().catch(() => ({}));
  if (data.errcode) return { error: data.errmsg || `微信错误 ${data.errcode}` };
  if (!data.openid) return { error: '未获取 openid' };
  return {
    openid: data.openid,
    sessionKey: data.session_key,
    unionid: data.unionid || null,
  };
}
