/**
 * 微信开放平台 · 网站应用扫码登录（qrconnect + OAuth2）
 * 文档：https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html
 *
 * 生产：AppID wxc4b560055c1978dc，redirect_uri https://qtvq.cn/wechat-callback.html
 * 开放平台须审核通过，授权回调域 qtvq.cn（仅域名模式）；详见 docs/WECHAT-OPEN-LOGIN.md
 */

export function getWechatOpenConfig(env) {
  return {
    appId: env.WECHAT_OPEN_APP_ID || '',
    secret: env.WECHAT_OPEN_APP_SECRET || '',
    redirectUri: env.WECHAT_OPEN_REDIRECT_URI || 'https://qtvq.cn/wechat-callback.html',
  };
}

export function isWechatOpenLoginConfigured(env) {
  const c = getWechatOpenConfig(env);
  return !!(c.appId && c.secret && c.redirectUri);
}

/** 供前端跳转的扫码登录 URL（redirect_uri 须与开放平台授权回调域一致） */
export function buildQrConnectUrl(env, state = 'qtvq') {
  const c = getWechatOpenConfig(env);
  const redirect = encodeURIComponent(c.redirectUri);
  const params = `appid=${c.appId}&redirect_uri=${redirect}&response_type=code&scope=snsapi_login&state=${encodeURIComponent(state)}`;
  return `https://open.weixin.qq.com/connect/qrconnect?${params}#wechat_redirect`;
}

export async function codeToOpenAccess(env, code) {
  const c = getWechatOpenConfig(env);
  if (!c.appId || !c.secret) return { error: '网站应用登录未配置' };
  if (!code) return { error: '缺少 code' };

  const qs = new URLSearchParams({
    appid: c.appId,
    secret: c.secret,
    code,
    grant_type: 'authorization_code',
  });
  const res = await fetch(`https://api.weixin.qq.com/sns/oauth2/access_token?${qs}`);
  const data = await res.json().catch(() => ({}));
  if (data.errcode) return { error: data.errmsg || `微信错误 ${data.errcode}` };
  if (!data.openid) return { error: '未获取 openid' };
  return {
    openid: data.openid,
    unionid: data.unionid || null,
    accessToken: data.access_token,
  };
}
