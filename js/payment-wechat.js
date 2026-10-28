import { apiUrl } from './config.js';
import { getClientId } from './quota.js';

async function parseJson(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || data.message || `请求失败 (${res.status})`);
    err.data = data;
    throw err;
  }
  return data;
}

/** @param {'native'|'jsapi'} channel */
export async function createWechatPayOrder(plan, channel = 'native', openid = null) {
  const body = { clientId: getClientId(), plan, channel };
  if (openid) body.openid = openid;
  const res = await fetch(apiUrl('/api/payment/wechat/create'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseJson(res);
}

export async function queryWechatPayOrder(orderId) {
  const clientId = getClientId();
  const q = new URLSearchParams({ orderId, clientId });
  const res = await fetch(apiUrl(`/api/payment/wechat/query?${q}`));
  return parseJson(res);
}

/** @returns {() => void} stop */
export function pollWechatPayOrder(orderId, { intervalMs = 5000, onPaid, onError } = {}) {
  let stopped = false;
  let attempts = 0;
  let timer = null;

  async function tick() {
    if (stopped) return;
    attempts += 1;
    try {
      // 备注：服务端的 query 接口在本地订单未支付时会主动向微信查真实交易状态并自愈开通，
      // 所以这里的轮询同时也是「回调没到」时的兜底通道。间隔不宜过短（会持续打微信查询接口）。
      const data = await queryWechatPayOrder(orderId);
      if (data.order?.status === 'paid') {
        stopped = true;
        onPaid?.(data);
        return;
      }
    } catch (e) {
      onError?.(e);
    }
    // 前 2 分钟每 5s；之后退避到 15s，避免用户挂着页面时一直高频查询
    const next = attempts < 24 ? intervalMs : 15000;
    if (!stopped) timer = setTimeout(tick, next);
  }

  tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
