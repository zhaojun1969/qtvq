import { post, get } from './request.js';
import { getClientId } from '../utils/clientId.js';

export function createWechatPayOrder(plan, channel = 'native', openidOrOpts = null) {
  const body = { clientId: getClientId(), plan, channel };
  if (typeof openidOrOpts === 'string') {
    body.openid = openidOrOpts;
  } else if (openidOrOpts && typeof openidOrOpts === 'object') {
    if (openidOrOpts.openid) body.openid = openidOrOpts.openid;
    if (openidOrOpts.code) body.code = openidOrOpts.code;
    if (openidOrOpts.uid) body.uid = openidOrOpts.uid;
  }
  return post('/api/payment/wechat/create', body);
}

export function queryWechatPayOrder(orderId) {
  const clientId = getClientId();
  return get('/api/payment/wechat/query', { orderId, clientId });
}

/**
 * 缘值充值下单（金额自定）。
 *
 * 与会员下单的区别：会员价由服务端套餐决定，充值金额必须由前端传 `amount`，
 * 服务端 `createTopupOrder` 会校验 ¥1–2000 且最多两位小数。
 *
 * `uid` 必须带：Node 侧钱包 users._id 复用的就是这个 uid（见 server/src/config/db.js），
 * 带上它付款成功后能直接给钱包入账；不带也能靠 clientId 反查，但多一次兜底路径。
 */
export function createTopupOrder(amount, channel = 'native', openidOrOpts = null) {
  const body = { clientId: getClientId(), plan: 'topup', amount, channel };
  if (typeof openidOrOpts === 'string') {
    body.openid = openidOrOpts;
  } else if (openidOrOpts && typeof openidOrOpts === 'object') {
    if (openidOrOpts.openid) body.openid = openidOrOpts.openid;
    if (openidOrOpts.code) body.code = openidOrOpts.code;
    if (openidOrOpts.uid) body.uid = openidOrOpts.uid;
  }
  return post('/api/payment/wechat/create', body);
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
