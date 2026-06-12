import { post, get } from './request.js';
import { getClientId } from '../utils/clientId.js';

export function createWechatPayOrder(plan, channel = 'native', openid = null) {
  const body = { clientId: getClientId(), plan, channel };
  if (openid) body.openid = openid;
  return post('/api/payment/wechat/create', body);
}

export function queryWechatPayOrder(orderId) {
  const clientId = getClientId();
  return get('/api/payment/wechat/query', { orderId, clientId });
}

/** @returns {() => void} */
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
