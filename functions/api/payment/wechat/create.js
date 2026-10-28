import { corsPreflight, jsonResponse } from '../../../lib/http.js';
import { validClientId, activatePayment, getQuota } from '../../../lib/quota-store.js';
import { createOrder, getPlan, updateOrder } from '../../../lib/order-store.js';
import { sendNoticeMail } from '../../../lib/mail.js';
import {
  createWechatNativeOrder,
  createWechatJsapiOrder,
  createWechatAppOrder,
  isWechatPayConfigured,
} from '../../../lib/wechat-pay.js';
import { createTopupOrder, TOPUP_PLAN_ID } from '../../../lib/order-store.js';
import { codeToSession } from '../../../lib/wechat-mp.js';

/** 取当前登录会话的手机号（脱敏）——运营核对时用来认人；未登录返回 null */
async function sessionPhone(env, request) {
  try {
    const h = request.headers.get('Authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return null;
    const { resolveSession, loadUserIdentity } = await import('../../../lib/auth-store.js');
    const resolved = await resolveSession(env, m[1].trim());
    // 手机号已迁到境内可识别字段，KV 副本里没有
    const identity = resolved ? await loadUserIdentity(env, resolved.user.id) : null;
    const p = identity?.phone || resolved?.user?.phone;
    return p ? `${p.slice(0, 3)}****${p.slice(-4)}` : null;
  } catch {
    return null;
  }
}

/** 下单失败告警的节流键：微信侧整体故障时避免把运营邮箱打爆 */
const FAIL_NOTICE_KEY = 'payfail:lastNoticeAt';
const FAIL_NOTICE_INTERVAL_MS = 10 * 60 * 1000;

function buildFailureHint(msg) {
  if (msg.includes('产品权限未开通') || msg.includes('NO_AUTH')) {
    return '请在商户平台 → 产品中心 开通 Native 支付 / JSAPI 支付';
  }
  if (/Invalid merchant private key/i.test(msg)) {
    return '私钥内容不完整或已失效：用 node tools/scripts/wechat-pem-setup.mjs --write 重写 .dev.vars 后重新推送+部署（历史上就是被截断的 PEM 造成此错）';
  }
  if (msg.includes('签名') || msg.includes('SIGN')) {
    return '请核对 WECHAT_MCH_SERIAL 是否与 apiclient_key.pem 对应证书序列号一致（商户平台 → API 安全 → 管理证书）';
  }
  if (/APIV3|平台证书|公钥/.test(msg)) {
    return '回调/应答验签相关：核对该商户号使用的是「微信支付公钥」还是「平台证书」模式';
  }
  return '若见 WECHAT_PAY_SIGNING_NOT_IMPLEMENTED，需在 functions/lib/wechat-pay.js 实现 V3 签名';
}

/**
 * 下单失败 → 邮件告警运营。
 *
 * 为什么必须有：2026-09-16 私钥被污染导致下单 502，**整整一天无人察觉** ——
 * 因为失败只体现在用户端弹窗里，运营侧零信号，而这段时间收入是完全中断的。
 * 带 10 分钟节流：微信整体故障时不会演变成邮件风暴。
 */
async function notifyPaymentFailure(env, { order, msg, hint }) {
  const kv = env?.QTVQ_KV;
  const now = Date.now();
  if (kv) {
    try {
      const last = Number(await kv.get(FAIL_NOTICE_KEY)) || 0;
      if (now - last < FAIL_NOTICE_INTERVAL_MS) return;
      await kv.put(FAIL_NOTICE_KEY, String(now), { expirationTtl: 86400 });
    } catch (err) {
      console.error('[create] 告警节流读写失败（继续发信）：', err);
    }
  }

  await sendNoticeMail(env, {
    subject: '[Q问收款][告警] 微信下单失败，客户无法付款',
    text: [
      '微信在线支付**下单接口返回失败**，此时客户拿不到付款二维码，收入处于中断状态。',
      '',
      `订单号：${order.orderId}`,
      `套餐：${order.planLabel || order.plan}（¥${order.amount}）`,
      `客户标识：${order.clientId}`,
      `错误信息：${msg}`,
      `排查建议：${hint}`,
      `时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
      '',
      '（同类告警 10 分钟内只发一次。客户仍可用静态收款码 + 「我已付款 · 提交核实」下单。）',
    ].join('\n'),
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight(request);
  if (request.method !== 'POST') {
    return jsonResponse(request, { error: 'Method not allowed' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, { error: '无效 JSON' }, 400);
  }

  const { clientId, plan, channel = 'native', openid, code, amount: topupAmount, uid } = body;
  if (!validClientId(clientId)) {
    return jsonResponse(request, { error: '无效的 clientId' }, 400);
  }

  // 缘值充值（方案 A）：金额自定，付款后加钱包余额而非开通会员
  const isTopup = plan === TOPUP_PLAN_ID;
  if (!isTopup && !getPlan(plan)) {
    return jsonResponse(request, { error: '无效的套餐 plan' }, 400);
  }

  // 渠道：jsapi（小程序/公众号内） / app（开放平台移动应用，鸿蒙/安卓/iOS 原生包） / native（扫码）
  const payChannel = channel === 'jsapi' ? 'wechat_jsapi' : channel === 'app' ? 'wechat_app' : 'wechat_native';

  /*
   * JSAPI 必须**先换到 openid，再建订单**。
   *
   * 原来的顺序是先建单、再在 try 里换 openid：code 换 session 失败时返回 400，
   * 可订单已经落库成 pending。而客户端（小程序钱包页）拿到 400 会退回扫码支付**再建一单** ——
   * 同一笔充值就留下两个 pending 订单，运营核对"客户说付了没反应"时更难判断。
   * 换序后：openid 拿不到就一单都不建，客户端退回扫码时只有那一单。
   */
  let payerOpenid = null;
  if (payChannel === 'wechat_jsapi') {
    payerOpenid = openid || null;
    if (!payerOpenid && code) {
      try {
        const wx = await codeToSession(env, code);
        // 微信返回的是英文原文（如 "invalid code, rid: xxx"），直接抛给用户看不懂，
        // 这里统一加中文前缀，rid 保留下来便于向微信侧追查。
        if (wx.error) {
          return jsonResponse(
            request,
            { error: `微信登录态已失效，请重新进入小程序再试（${wx.error}）`, hint: '也可直接改用扫码支付' },
            400,
          );
        }
        payerOpenid = wx.openid;
      } catch (err) {
        return jsonResponse(
          request,
          { error: `微信登录态换取失败：${err?.message || '请重试'}`, hint: '可改用扫码支付' },
          502,
        );
      }
    }
    if (!payerOpenid) {
      return jsonResponse(request, { error: 'JSAPI 支付需要 openid 或微信 code', hint: '可改用扫码支付' }, 400);
    }
  }

  /*
   * 记录**可识别信息**：运营事后核对时，光有一个 clientId（q_xxx）根本认不出是谁。
   * 业务方 2026-09-18 实际反馈："查出这么多没有解禁的，基本的微信名和时间 IP 地址都没有，
   * 无法确定是哪个用户"。所以下单时就把 下单时间 / 登录手机 / IP / 浏览器 一起写进订单。
   */
  const trace = {
    ip: request.headers.get('CF-Connecting-IP') || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() || '',
    userAgent: (request.headers.get('User-Agent') || '').slice(0, 180),
    phone: await sessionPhone(env, request),
    uid: uid || null,
  };

  const created = isTopup
    ? await createTopupOrder(env, {
        clientId,
        amountYuan: topupAmount,
        uid,
        channel: payChannel,
        openid: openid || null,
        trace,
      })
    : await createOrder(env, {
        clientId,
        planId: plan,
        channel: payChannel,
        openid: openid || null,
        trace,
      });
  if (created.error) return jsonResponse(request, { error: created.error }, 400);

  const { order } = created;
  const description = isTopup ? 'Q问缘值充值' : `Q问会员-${order.planLabel}`;

  try {
    let payResult;
    if (payChannel === 'wechat_jsapi') {
      // payerOpenid 已在建单前解析好（见上方注释），这里必然有值
      payResult = await createWechatJsapiOrder(env, request, {
        orderId: order.orderId,
        description,
        amountFen: order.amountFen,
        openid: payerOpenid,
      });
    } else if (payChannel === 'wechat_app') {
      // App 内支付（鸿蒙/安卓/iOS 原生包）：返回 orderInfo 字符串，
      // 客户端调 uni.requestPayment({ provider: 'wxpay', orderInfo })。
      // 需要「微信开放平台 → 移动应用」的 appid（WECHAT_APP_PAY_ID），未配置时返回 stub 并说明原因。
      payResult = await createWechatAppOrder(env, request, {
        orderId: order.orderId,
        description,
        amountFen: order.amountFen,
      });
    } else {
      payResult = await createWechatNativeOrder(env, request, {
        orderId: order.orderId,
        description,
        amountFen: order.amountFen,
      });
    }

    await updateOrder(env, order.orderId, {
      codeUrl: payResult.codeUrl || null,
      prepayId: payResult.prepayId || null,
    });

    return jsonResponse(request, {
      ok: true,
      stub: !!payResult.stub,
      configured: isWechatPayConfigured(env),
      orderId: order.orderId,
      plan: order.plan,
      planLabel: order.planLabel,
      amount: order.amount,
      channel: payChannel,
      codeUrl: payResult.codeUrl || null,
      jsapi: payResult.jsapi || null,
      orderInfo: payResult.orderInfo || null,
      message: payResult.message || null,
    });
  } catch (err) {
    const msg = err.message || '微信下单失败';
    const hint = buildFailureHint(msg);

    // 失败留痕：以前只把 status 改成 failed，没有原因，事后完全查不出为什么。
    await updateOrder(env, order.orderId, {
      status: 'failed',
      failureReason: msg,
      failedAt: Date.now(),
    });

    // 告警不能影响给用户的返回：发信失败必须吞掉
    try {
      await notifyPaymentFailure(env, { order, msg, hint });
    } catch (mailErr) {
      console.error('[create] 下单失败告警发送失败：', mailErr);
    }

    return jsonResponse(request, { error: msg, orderId: order.orderId, hint }, 502);
  }
}
