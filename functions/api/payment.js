import { submitPayment, activatePayment, getQuota, listPendingPayments } from '../lib/quota-store.js';
import { listRecentOrders } from '../lib/order-store.js';
import { resolveSession } from '../lib/auth-store.js';
import { corsPreflight, jsonResponse } from '../lib/http.js';
import { sendNoticeMail } from '../lib/mail.js';
const COMPANY = {
  name: '我心永恒（北京）网络科技有限公司',
  account: '0200251109200028909',
  cardNo: '9558830200002033769',
  bank: '中国工商银行北京海淀西区马连洼支行',
};

function bearerToken(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function authPhone(env, request) {
  const token = bearerToken(request);
  if (!token) return null;
  const resolved = await resolveSession(env, token);
  if (!resolved) return null;
  const p = resolved.user.phone;
  return `${p.slice(0, 3)}****${p.slice(-4)}`;
}

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
    if (url.searchParams.get('list') === 'orders') {
      if (!checkAdmin(env, adminKey)) return jsonResponse(request, { error: '无权限' }, 403);
      const orders = await listRecentOrders(env);
      return jsonResponse(request, orders);
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

  const phone = await authPhone(env, request);
  const result = await submitPayment(env, clientId, {
    plan,
    payerName: String(payerName).slice(0, 40),
    paidAt: String(paidAt).slice(0, 40),
    amount: Number(amount),
    remark: String(remark || '').slice(0, 80),
    phone,
  });

  if (result?.error) return jsonResponse(request, { error: result.error }, 400);
  if (!result) return jsonResponse(request, { error: '提交失败' }, 400);

  // 手动收款码 / 对公汇款：客户提交核实后**立刻**通知运营。
  // 静态收款码（含聚合码）没有任何回调，钱进了账户但我们收不到通知 ——
  // 所以「客户提交核实」是唯一能立即知道有人付款的时点。
  // 此前只写进待核实列表，要人工去翻，属漏单隐患（2026-09-16 业务方反馈）。
  // 发送失败一律吞掉：不能因为通知失败就让客户提交失败、或丢掉这条待核实记录。
  try {
    const amountCn = Number(amount).toFixed(2);
    await sendNoticeMail(env, {
      subject: `[Q问待核实] ${payerName} 提交付款核实 · ¥${amountCn} · ${plan}`,
      text: [
        '有客户提交了付款核实，请在核对到账后为其开通会员。',
        '',
        `付款人：${payerName}`,
        `金额：¥${amountCn}`,
        `套餐：${plan}`,
        `付款时间（客户填写）：${paidAt}`,
        `备注/后四位：${remark || '（未填）'}`,
        `客户标识：${clientId}`,
        `绑定手机：${phone || '（未绑定/未登录）'}`,
        '',
        '核实并开通：https://qtvq-api.pages.dev/tools/verify-payment.html',
        '',
        '说明：静态收款码与对公汇款没有支付回调，无法自动到账识别；',
        '如需自动开通，请让客户走「微信在线支付」（会自动开通并通知）。',
      ].join('\n'),
    });
  } catch (err) {
    console.error('[payment] 待核实通知邮件发送失败：', err);
  }

  return jsonResponse(request, {
    ok: true,
    pending: result,
    message: '已登记付款信息，客服核对到账后立即为你开通会员（也可联系客服加急）',
    company: COMPANY,
  });
}
