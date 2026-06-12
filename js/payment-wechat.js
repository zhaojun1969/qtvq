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
export function pollWechatPayOrder(orderId, { intervalMs = 3000, onPaid, onError } = {}) {
  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    try {
      const data = await queryWechatPayOrder(orderId);
      if (data.order?.status === 'paid') {
        stopped = true;
        onPaid?.(data);
        return;
      }
    } catch (e) {
      onError?.(e);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  }

  tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
