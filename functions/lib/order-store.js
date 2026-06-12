/**
 * 支付订单 KV 存储（与 quota-store 共用 QTVQ_KV）
 */

import { PLANS, validClientId } from './quota-store.js';

const ORDER_PREFIX = 'order:';
const memoryOrders = new Map();

function getKv(env) {
  return env?.QTVQ_KV || null;
}

function orderKey(orderId) {
  return `${ORDER_PREFIX}${orderId}`;
}

function newOrderId() {
  return `ord_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function yuanToFen(yuan) {
  return Math.round(Number(yuan) * 100);
}

export function getPlan(planId) {
  return PLANS[planId] || null;
}

export async function createOrder(env, { clientId, planId, channel, openid = null }) {
  const plan = getPlan(planId);
  if (!plan || !validClientId(clientId)) return { error: '无效的 clientId 或套餐' };

  const orderId = newOrderId();
  const now = Date.now();
  const order = {
    orderId,
    clientId,
    plan: planId,
    planLabel: plan.label,
    amount: plan.price,
    amountFen: yuanToFen(plan.price),
    channel: channel || 'wechat_native',
    openid: openid || null,
    status: 'pending',
    platformTradeNo: null,
    prepayId: null,
    codeUrl: null,
    createdAt: now,
    paidAt: null,
  };

  const kv = getKv(env);
  if (kv) {
    await kv.put(orderKey(orderId), JSON.stringify(order));
  } else {
    memoryOrders.set(orderId, order);
  }

  return { order };
}

export async function getOrder(env, orderId) {
  if (!orderId || typeof orderId !== 'string') return null;
  const kv = getKv(env);
  if (kv) {
    const raw = await kv.get(orderKey(orderId));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return memoryOrders.get(orderId) || null;
}

async function saveOrder(env, order) {
  const kv = getKv(env);
  if (kv) {
    await kv.put(orderKey(order.orderId), JSON.stringify(order));
  } else {
    memoryOrders.set(order.orderId, order);
  }
}

export async function updateOrder(env, orderId, patch) {
  const order = await getOrder(env, orderId);
  if (!order) return null;
  Object.assign(order, patch);
  await saveOrder(env, order);
  return order;
}

/** 幂等：已 paid 则直接返回 */
export async function markOrderPaid(env, orderId, { platformTradeNo, paidAt = Date.now() } = {}) {
  const order = await getOrder(env, orderId);
  if (!order) return { error: '订单不存在' };
  if (order.status === 'paid') return { order, alreadyPaid: true };

  order.status = 'paid';
  order.platformTradeNo = platformTradeNo || order.platformTradeNo;
  order.paidAt = paidAt;
  await saveOrder(env, order);
  return { order, alreadyPaid: false };
}

export { PLANS };
