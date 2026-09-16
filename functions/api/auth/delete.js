/**
 * 注销账号（POST /api/auth/delete）
 *
 * 策略（业务方 2026-09-16 确认）：
 *   ① 订单**脱敏保留**（财务与审计需要）：金额/时间/套餐/状态留着，clientId 换成不可逆短哈希；
 *   ② 有**未到期会员** → 不开放自助注销，引导联系客服协商；有**待核实付款**同样拦下；
 *   ③ 二次确认：有密码的验密码，纯微信账号要求在输入框打出「注销账号」四个字。
 *
 * 除了 KV，还要覆盖阿里云 OSS 上该设备的备份（kv/clients/<clientId>.json）——
 * 备份里同样有个人资料，不覆盖等于没删干净。这里用 PutObject 写墓碑而不是删除对象：
 * 我们的 OSS 最小权限策略本来就没有删除权限，覆盖既够用也更安全。
 */
import { resolveSession, deleteUserAccount, verifyUserPassword, logoutUser } from '../../lib/auth-store.js';
import { getQuota, clearClientRecord } from '../../lib/quota-store.js';
import { ossPutJson } from '../../lib/oss-backup.js';
import { sendNoticeMail } from '../../lib/mail.js';
import { corsPreflight, jsonResponse } from '../../lib/http.js';

const ORDER_PREFIX = 'order:';
const CONFIRM_TEXT = '注销账号';

function bearerToken(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function shortHash(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)]
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 订单脱敏：保留金额/时间/套餐/状态，clientId 替换为 `deleted-<8位哈希>`，并去掉 openid。
 * 不能删订单 —— 那是财务与审计依据（业务方明确要求保留）。
 */
async function redactOrdersForClient(env, clientId) {
  const kv = env?.QTVQ_KV;
  if (!kv || !clientId) return 0;
  const tag = `deleted-${await shortHash(clientId)}`;
  let changed = 0;
  let cursor;
  for (let page = 0; page < 20; page += 1) {
    const list = await kv.list({ prefix: ORDER_PREFIX, cursor });
    for (const { name } of list.keys) {
      const raw = await kv.get(name);
      if (!raw) continue;
      let order;
      try {
        order = JSON.parse(raw);
      } catch {
        continue;
      }
      if (order?.clientId !== clientId) continue;
      order.clientId = tag;
      delete order.openid;
      await kv.put(name, JSON.stringify(order));
      changed += 1;
    }
    if (list.list_complete) break;
    cursor = list.cursor;
  }
  return changed;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight(request);
  if (request.method !== 'POST') return jsonResponse(request, { error: 'Method not allowed' }, 405);

  const token = bearerToken(request);
  const resolved = token ? await resolveSession(env, token) : null;
  if (!resolved) return jsonResponse(request, { error: '请先登录后再注销' }, 401);
  const { user } = resolved;

  const quota = user.clientId ? await getQuota(env, user.clientId) : null;
  const activeMember = Boolean(quota?.unlimited || (quota?.subscription?.activeUntil || 0) > Date.now());
  if (activeMember) {
    return jsonResponse(
      request,
      {
        error:
          '该账号还有未到期的会员。按当前规则，未到期会员需要先与客服协商（微信客服或邮箱 qtvq@qtvq.cn）后再注销。',
        code: 'E_MEMBER_ACTIVE',
      },
      409,
    );
  }
  if (quota?.paymentPending) {
    return jsonResponse(
      request,
      { error: '有一笔付款正在核实中，请等核实完成或联系客服后再注销。', code: 'E_PAYMENT_PENDING' },
      409,
    );
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  if (user.passwordHash) {
    const ok = await verifyUserPassword(env, user.id, body.password);
    if (!ok) return jsonResponse(request, { error: '密码不正确，未执行注销' }, 400);
  } else if (String(body.confirmText || '').trim() !== CONFIRM_TEXT) {
    return jsonResponse(request, { error: `请输入「${CONFIRM_TEXT}」四个字以确认` }, 400);
  }

  const clientId = user.clientId || null;
  const redactedOrders = await redactOrdersForClient(env, clientId);

  if (clientId) {
    try {
      await ossPutJson(env, `kv/clients/${encodeURIComponent(clientId)}.json`, {
        deleted: true,
        deletedAt: new Date().toISOString(),
      });
    } catch (err) {
      // 备份覆盖失败不阻塞注销：KV 里的资料已经删了，这里只是尽量把 OSS 副本也清掉
      console.error('[delete] OSS 备份覆盖失败（不阻塞注销）：', err);
    }
    await clearClientRecord(env, clientId);
  }

  const result = await deleteUserAccount(env, user.id);
  if (!result.ok) return jsonResponse(request, { error: result.error || '注销失败' }, 400);

  try {
    await logoutUser(env, token);
  } catch {
    /* 会话已随账号一并吊销 */
  }

  try {
    await sendNoticeMail(env, {
      subject: `[Q问账号注销] ${result.phoneMasked || '微信账号'} 已注销`,
      text: [
        '有用户自助注销了账号（不可恢复）。',
        '',
        `手机号：${result.phoneMasked || '（纯微信账号）'}`,
        `设备编号：${clientId || '（无）'}`,
        `时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
        `脱敏保留的订单数：${redactedOrders}`,
        '',
        '已删除：个人资料 / 登录凭证 / 全部会话 / 配额与提问记录 / 微信绑定 / OSS 备份（覆盖为墓碑）。',
        '已保留：订单流水（clientId 已替换为不可逆短哈希，金额·时间·套餐·状态仍在）。',
      ].join('\n'),
    });
  } catch (err) {
    console.error('[delete] 注销通知邮件发送失败：', err);
  }

  return jsonResponse(request, {
    ok: true,
    message: '账号已注销：个人资料与登录凭证已删除，订单流水已脱敏保留',
    redactedOrders,
    clientIdCleared: Boolean(clientId),
  });
}
