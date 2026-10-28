import { submitPayment, submitTopup, activatePayment, getQuota, listPendingPayments } from '../lib/quota-store.js';
import { listRecentOrders } from '../lib/order-store.js';
import { resolveSession, loadUserIdentity } from '../lib/auth-store.js';
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
  // 手机号在境内可识别字段里（KV 副本已剥离），收款通知要认人，必须取回来
  const identity = await loadUserIdentity(env, resolved.user.id);
  const p = identity?.phone || resolved.user.phone;
  return p ? `${p.slice(0, 3)}****${p.slice(-4)}` : null;
}

function checkAdmin(env, adminKey) {
  const key = env.PAYMENT_ADMIN_KEY || env.ADMIN_KEY;
  return key && adminKey === key;
}

export async function onRequest(context) {
  try {
    return await handle(context);
  } catch (err) {
    // 函数里任何未捕获异常都会让 Cloudflare 返回**HTML 的 500**，前端只能显示
    // "服务端未返回 JSON 原因" —— 排查时等于零线索（2026-09-17 就卡在这里）。
    // 统一兜住，把真实异常以 JSON 返回，前端与控制台都能看到原因。
    console.error('[payment] 未捕获异常：', err);
    return jsonResponse(
      context.request,
      {
        error: `服务处理异常：${err?.message || String(err)}`,
        code: 'INTERNAL_ERROR',
        where: String(err?.stack || '').split('\n')[1]?.trim() || null,
      },
      500,
    );
  }
}

async function handle(context) {
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

  const { plan, payerName, paidAt, amount, remark, purpose } = body;

  // 缘值充值（任意金额，静态收款码 + 提交核实）—— 与会员核实彻底分开：
  // 会员核实会走 activatePayment，充值不该开通会员，因此用独立字段与独立通知。
  if (plan === 'topup' || purpose === 'topup') {
    if (!clientId || !payerName || !paidAt || amount == null) {
      return jsonResponse(request, { error: '请填写完整充值信息（金额、付款人、时间）' }, 400);
    }
    const phone = await authPhone(env, request);
    const result = await submitTopup(env, clientId, {
      amount,
      payerName: String(payerName).slice(0, 40),
      paidAt: String(paidAt).slice(0, 40),
      remark: String(remark || '').slice(0, 80),
      phone,
    });
    if (result?.error) return jsonResponse(request, { error: result.error }, 400);
    if (!result) return jsonResponse(request, { error: '提交失败' }, 400);

    let noticeSent = false;
    let noticeError = null;
    try {
      await sendNoticeMail(env, {
        subject: `[Q问待核实] 缘值充值 ¥${Number(result.amount).toFixed(2)} · ${payerName}`,
        text: [
          '有客户提交了**缘值充值**的付款核实（静态收款码，无自动回调）。',
          '请在核对到账后，到运营台给该用户的余额入账（运营台 → 钱包 → 入账）。',
          '',
          `充值金额：¥${Number(result.amount).toFixed(2)}`,
          `付款人：${payerName}`,
          `付款时间（客户填写）：${paidAt}`,
          `备注/后四位：${remark || '（未填）'}`,
          `客户标识（clientId）：${clientId}`,
          `绑定手机：${phone || '（未绑定/未登录）'}`,
          '',
          '⚠️ 入账时按「绑定手机」或 clientId 在运营台找到对应用户；',
          '   若找不到对应用户，请先与客户确认其登录手机号，避免错充。',
          '',
          `提示：会员开通请用运营台核实页；本条是**缘值充值**，只加余额、不开通会员。`,
        ].join('\n'),
      });
      noticeSent = true;
    } catch (err) {
      noticeError = err?.message || String(err);
      console.error('[payment] 充值待核实通知邮件发送失败：', err);
    }

    return jsonResponse(request, {
      ok: true,
      pending: result,
      // 把"通知是否真的发出去了"返回给前端：以前发送失败被静默吞掉，
      // 用户看到"已登记"，运营却什么都没收到 —— 客户以为通知了，运营以为没人付款，
      // 这是最容易造成漏单的组合。现在前端可以据此提示"请同时联系客服"。
      noticeSent,
      noticeError,
      message: noticeSent
        ? '已登记充值信息，并已通知客服核对到账'
        : '已登记充值信息，但自动通知未成功，请同时联系客服（qtvq@qtvq.cn）加急',
      company: COMPANY,
    });
  }

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
  let memberNoticeSent = false;
  let memberNoticeError = null;
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
        '核实并开通：https://qtvq.cn/tools/verify-payment.html',
        '步骤：打开该页 → 输入运营口令 → 核对到账 → 点「核实并开通」。',
        '',
        '说明：静态收款码与对公汇款没有支付回调，无法自动到账识别；',
        '如需自动开通，请让客户走「微信在线支付」（付完自动开通，无需本步骤）。',
      ].join('\n'),
    });
    memberNoticeSent = true;
  } catch (err) {
    memberNoticeError = err?.message || String(err);
    console.error('[payment] 待核实通知邮件发送失败：', err);
  }

  return jsonResponse(request, {
    ok: true,
    pending: result,
    noticeSent: memberNoticeSent,
    noticeError: memberNoticeError,
    message: memberNoticeSent
      ? '已登记付款信息，并已通知客服核对到账（核实通过后立即开通会员）'
      : '已登记付款信息，但自动通知未成功，请同时联系客服（qtvq@qtvq.cn）加急',
    company: COMPANY,
  });
}
