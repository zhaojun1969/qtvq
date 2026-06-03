import {
  submitPayment,
  activatePayment,
  getQuota,
  listPendingPayments,
} from '../lib/quota-store.js';
import { corsPreflight, jsonResponse } from '../lib/http.js';

const COMPANY = {
  name: '我心永恒（北京）网络科技有限公司',
  account: '0200251109200028909',
  cardNo: '9558830200002033769',
  bank: '中国工商银行北京海淀西区马连洼支行',
};

function checkAdmin(env, adminKey) {
  const key = env.PAYMENT_ADMIN_KEY || env.ADMIN_KEY;
  return key && adminKey === key;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight(request);

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const adminKey = url.searchParams.get('adminKey');
    if (url.searchParams.get('list') === 'pending') {
      if (!checkAdmin(env, adminKey)) return jsonResponse(request, { error: '无权限' }, 403);
      const list = await listPendingPayments(env);
      return jsonResponse(request, { company: COMPANY, ...list });
    }
    return jsonResponse(request, { company: COMPANY });
  }

  if (request.method !== 'POST') {
    return jsonResponse(request, { error: 'Method not allowed' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, { error: '无效 JSON' }, 400);
  }

  const { action, clientId, adminKey } = body;

  if (action === 'verify') {
    if (!checkAdmin(env, adminKey)) return jsonResponse(request, { error: '无权限' }, 403);
    if (!clientId || !body.plan) return jsonResponse(request, { error: '缺少 clientId 或 plan' }, 400);
    const ok = await activatePayment(env, clientId, body.plan);
    if (!ok) return jsonResponse(request, { error: '激活失败' }, 400);
    return jsonResponse(request, {
      ok: true,
      message: '已核实汇款，提问已解禁',
      quota: await getQuota(env, clientId),
    });
  }

  const { plan, payerName, paidAt, amount, remark } = body;
  if (!clientId || !plan || !payerName || !paidAt || amount == null) {
    return jsonResponse(request, { error: '请填写完整汇款信息' }, 400);
  }

  const result = await submitPayment(env, clientId, {
    plan,
    payerName: String(payerName).slice(0, 40),
    paidAt: String(paidAt).slice(0, 40),
    amount: Number(amount),
    remark: String(remark || '').slice(0, 80),
  });

  if (result?.error) return jsonResponse(request, { error: result.error }, 400);
  if (!result) return jsonResponse(request, { error: '提交失败' }, 400);

  return jsonResponse(request, {
    ok: true,
    pending: result,
    message: '已登记汇款信息，工作人员核对工商银行到账后将为您解禁不限次数提问',
    company: COMPANY,
  });
}
