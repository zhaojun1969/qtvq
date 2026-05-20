import {
  submitPayment,
  activatePayment,
  getQuota,
  listPendingPayments,
} from '../lib/quota-store.js';

const COMPANY = {
  name: '我心永恒（北京）网络科技有限公司',
  account: '0200251109200028909',
  cardNo: '9558830200002033769',
  bank: '中国工商银行北京海淀西区马连洼支行',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function checkAdmin(env, adminKey) {
  const key = env.PAYMENT_ADMIN_KEY || env.ADMIN_KEY;
  return key && adminKey === key;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const adminKey = url.searchParams.get('adminKey');
    if (url.searchParams.get('list') === 'pending') {
      if (!checkAdmin(env, adminKey)) return json({ error: '无权限' }, 403);
      const list = await listPendingPayments(env);
      return json({ company: COMPANY, ...list });
    }
    return json({ company: COMPANY });
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '无效 JSON' }, 400);
  }

  const { action, clientId, adminKey } = body;

  if (action === 'verify') {
    if (!checkAdmin(env, adminKey)) return json({ error: '无权限' }, 403);
    if (!clientId || !body.plan) return json({ error: '缺少 clientId 或 plan' }, 400);
    const ok = await activatePayment(env, clientId, body.plan);
    if (!ok) return json({ error: '激活失败' }, 400);
    return json({
      ok: true,
      message: '已核实汇款，提问已解禁',
      quota: await getQuota(env, clientId),
    });
  }

  const { plan, payerName, paidAt, amount, remark } = body;
  if (!clientId || !plan || !payerName || !paidAt || amount == null) {
    return json({ error: '请填写完整汇款信息' }, 400);
  }

  const result = await submitPayment(env, clientId, {
    plan,
    payerName: String(payerName).slice(0, 40),
    paidAt: String(paidAt).slice(0, 40),
    amount: Number(amount),
    remark: String(remark || '').slice(0, 80),
  });

  if (result?.error) return json({ error: result.error }, 400);
  if (!result) return json({ error: '提交失败' }, 400);

  return json({
    ok: true,
    pending: result,
    message: '已登记汇款信息，工作人员核对工商银行到账后将为您解禁不限次数提问',
    company: COMPANY,
  });
}
