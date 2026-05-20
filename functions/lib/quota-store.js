/**
 * 提问额度与会员状态
 * 绑定 Cloudflare KV（QTVQ_KV）时持久化；未绑定时使用内存（仅适合本地调试）
 */

const DAILY_ASK_LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const KV_PREFIX = 'client:';

const PLANS = {
  month: { label: '月卡', price: 288, days: 30 },
  quarter: { label: '季卡', price: 788, days: 90 },
  year: { label: '年卡', price: 2888, days: 365 },
};

const memory = new Map();

function defaultClient() {
  return { timestamps: [], subscription: null, paymentPending: null };
}

function getKv(env) {
  return env?.QTVQ_KV || null;
}

function kvKey(clientId) {
  return `${KV_PREFIX}${clientId}`;
}

async function loadRecord(env, clientId) {
  const kv = getKv(env);
  if (kv) {
    const raw = await kv.get(kvKey(clientId));
    if (raw) {
      try {
        return { ...defaultClient(), ...JSON.parse(raw) };
      } catch {
        return defaultClient();
      }
    }
    return defaultClient();
  }
  if (!memory.has(clientId)) memory.set(clientId, defaultClient());
  return memory.get(clientId);
}

async function saveRecord(env, clientId, rec) {
  const kv = getKv(env);
  if (kv) {
    await kv.put(kvKey(clientId), JSON.stringify(rec));
  } else {
    memory.set(clientId, rec);
  }
}

function prune(ts, now) {
  const cutoff = now - WINDOW_MS;
  return ts.filter((t) => t > cutoff);
}

function buildQuota(rec, now = Date.now()) {
  rec.timestamps = prune(rec.timestamps, now);
  const unlimited = rec.subscription?.activeUntil > now;
  const used = rec.timestamps.length;
  const oldest = rec.timestamps.length ? Math.min(...rec.timestamps) : null;
  return {
    unlimited,
    used,
    remaining: unlimited ? null : Math.max(0, DAILY_ASK_LIMIT - used),
    limit: DAILY_ASK_LIMIT,
    resetAt: oldest ? oldest + WINDOW_MS : null,
    subscription: rec.subscription,
    paymentPending: rec.paymentPending,
    plans: PLANS,
  };
}

export function validClientId(clientId) {
  return clientId && typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 64;
}

export async function getQuota(env, clientId) {
  if (!validClientId(clientId)) return null;
  const rec = await loadRecord(env, clientId);
  const q = buildQuota(rec);
  q.storage = getKv(env) ? 'kv' : 'memory';
  return q;
}

export async function canAsk(env, clientId, followUp) {
  if (followUp) return { ok: true };
  const q = await getQuota(env, clientId);
  if (!q) return { ok: false, error: '无效的客户端标识' };
  if (q.unlimited || q.remaining > 0) return { ok: true };
  return { ok: false, code: 'QUOTA_EXCEEDED', quota: q };
}

export async function recordAsk(env, clientId) {
  if (!validClientId(clientId)) return;
  const rec = await loadRecord(env, clientId);
  const now = Date.now();
  rec.timestamps = prune(rec.timestamps, now);
  rec.timestamps.push(now);
  await saveRecord(env, clientId, rec);
}

export async function submitPayment(env, clientId, data) {
  const plan = PLANS[data.plan];
  if (!plan || !validClientId(clientId)) return null;
  if (Number(data.amount) !== plan.price) return { error: '汇款金额与所选套餐不一致' };
  const rec = await loadRecord(env, clientId);
  rec.paymentPending = {
    plan: data.plan,
    planLabel: plan.label,
    amount: plan.price,
    payerName: data.payerName,
    paidAt: data.paidAt,
    remark: data.remark,
    status: 'pending',
    submittedAt: Date.now(),
  };
  await saveRecord(env, clientId, rec);
  return rec.paymentPending;
}

export async function activatePayment(env, clientId, planId) {
  const plan = PLANS[planId];
  if (!plan || !validClientId(clientId)) return false;
  const rec = await loadRecord(env, clientId);
  const base = Math.max(Date.now(), rec.subscription?.activeUntil || 0);
  rec.subscription = {
    plan: planId,
    label: plan.label,
    activeUntil: base + plan.days * 24 * 60 * 60 * 1000,
    activatedAt: Date.now(),
  };
  rec.paymentPending = null;
  await saveRecord(env, clientId, rec);
  return true;
}

/** 工作人员：列出待核实汇款（需 KV） */
export async function listPendingPayments(env) {
  const kv = getKv(env);
  if (!kv) {
    const items = [];
    for (const [id, rec] of memory.entries()) {
      if (rec.paymentPending?.status === 'pending') {
        items.push({ clientId: id, ...rec.paymentPending });
      }
    }
    return { items, storage: 'memory' };
  }
  const list = await kv.list({ prefix: KV_PREFIX });
  const items = [];
  for (const { name } of list.keys) {
    const raw = await kv.get(name);
    if (!raw) continue;
    try {
      const rec = JSON.parse(raw);
      if (rec.paymentPending?.status === 'pending') {
        items.push({
          clientId: name.slice(KV_PREFIX.length),
          ...rec.paymentPending,
        });
      }
    } catch {
      /* skip */
    }
  }
  items.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
  return { items, storage: 'kv' };
}

export { PLANS, DAILY_ASK_LIMIT };
