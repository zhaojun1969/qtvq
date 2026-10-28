/**
 * 提问额度与会员状态
 *
 * 2026-10-26 · G1「数据境内化」最后一块
 * -------------------------------------
 * 这个模块此前把整条客户端记录写进 Cloudflare KV（`client:<id>`），其中包括：
 *   · `paymentPending` / `topupPending` —— **付款人真实姓名、手机号、备注**；
 *   · `paymentHistory` —— 历史付款记录，同样含姓名与手机。
 * 这些是典型的个人信息，存在由 Cloudflare 全球网络承载的 KV 上即构成数据出境。
 *
 * 但这条记录同时是**热路径**：每次提问都要读 `timestamps` 判额度。
 * 整条搬到境内 Mongo 会让每一次提问都多一次公网往返，把 API P50 从 2ms 拉到几十毫秒。
 *
 * 所以按「热路径是否需要」拆开：
 *   · **KV** `client:<id>`：`timestamps` + `subscription` —— 判额度与会员状态只需要这两项，**不含 PII**；
 *   · **境内 Mongo** `client_billing`：`paymentPending` / `topupPending` / `paymentHistory` 明细。
 *
 * 读路径的取舍：
 *   · `canAsk`（每次提问）走 `withBilling: false` —— 只读 KV，热路径不变慢；
 *   · `getQuota`（账户页 / 提交后回显）默认带 billing —— 多一次境内往返，低频可接受。
 *
 * 未绑定 KV 时（本地调试）仍用内存，并把 billing 一并放内存，行为与改造前一致。
 */

const DAILY_ASK_LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const KV_PREFIX = 'client:';

const PLANS = {
  month: { label: '月卡', price: 29, days: 30 },
  quarter: { label: '季卡', price: 79, days: 90 },
  year: { label: '年卡', price: 299, days: 365 },
};

const memory = new Map();

function defaultClient() {
  return { timestamps: [], subscription: null, paymentPending: null, paymentHistory: [] };
}

function getKv(env) {
  return env?.QTVQ_KV || null;
}

function kvKey(clientId) {
  return `${KV_PREFIX}${clientId}`;
}

/* ------------------------------------------------------------ 境内 billing 明细 */

const BILLING_KEYS = ['paymentPending', 'topupPending', 'paymentHistory'];
/*
 * 1500ms 而不是 3000ms：2026-10-26 实测 Pages→源站这段链路会偶发数秒级退化
 * （同一时刻**旧部署**的 `/api/health` 也 20s 超时，见文档附录 E.13 的 A/B 证据，
 * 所以退化与本次拆分无关）。这里是**读**明细，超时只导致账户页少显示待核实；
 * 写明细失败另走明确错误返回，不会被静默吞掉。
 */
const BILLING_TIMEOUT_MS = 1500;

function nodeConfig(env) {
  const base = String(env?.NODE_API_BASE || '').replace(/\/+$/, '');
  const adminKey = String(env?.NODE_ADMIN_KEY || '');
  return base && adminKey ? { base, adminKey } : null;
}

function billingPayload(clientId, rec) {
  return {
    clientId,
    paymentPending: rec.paymentPending || null,
    topupPending: rec.topupPending || null,
    paymentHistory: Array.isArray(rec.paymentHistory) ? rec.paymentHistory.slice(0, 20) : [],
  };
}

/** 读境内 billing 明细；未配置或失败时返回 null（调用方按"没有明细"处理） */
async function loadBilling(env, clientId) {
  if (!getKv(env)) {
    const rec = memory.get(clientId);
    return rec ? { ...billingPayload(clientId, rec) } : null;
  }
  const cfg = nodeConfig(env);
  if (!cfg) return null;
  try {
    const res = await fetch(`${cfg.base}/v1/admin/client-billing/${encodeURIComponent(clientId)}`, {
      headers: { 'X-Admin-Key': cfg.adminKey, 'User-Agent': 'qtvq-billing/1.0 (+https://qtvq.cn)' },
      signal: AbortSignal.timeout(BILLING_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.error(`[quota] 读取境内 billing 失败 ${clientId} HTTP ${res.status}`);
      return null;
    }
    const j = await res.json().catch(() => null);
    return j?.data || null;
  } catch (err) {
    console.error('[quota] 读取境内 billing 异常：', err?.message || err);
    return null;
  }
}

/**
 * 写境内 billing 明细。永不抛异常。
 *
 * 只发送**有值**的字段：调用方可能只改其中一项（例如提交流水时并不碰 paymentHistory），
 * 无条件覆盖会把其他两项抹成 null —— 订单那批已经踩过同样的坑。
 */
async function saveBilling(env, clientId, patch) {
  if (!getKv(env)) {
    const rec = memory.get(clientId) || defaultClient();
    Object.assign(rec, patch);
    memory.set(clientId, rec);
    return { ok: true, storage: 'memory' };
  }
  const cfg = nodeConfig(env);
  if (!cfg) return { ok: false, reason: 'not-configured' };
  const body = { clientId };
  for (const k of BILLING_KEYS) if (patch[k] !== undefined) body[k] = patch[k];
  try {
    const res = await fetch(`${cfg.base}/v1/admin/client-billing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': cfg.adminKey,
        'User-Agent': 'qtvq-billing/1.0 (+https://qtvq.cn)',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BILLING_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[quota] 写入境内 billing 失败 ${clientId} HTTP ${res.status}`);
      return { ok: false, reason: `http-${res.status}` };
    }
    return { ok: true, storage: 'mongo-cn' };
  } catch (err) {
    console.error('[quota] 写入境内 billing 异常：', err?.message || err);
    return { ok: false, reason: 'network' };
  }
}

/* ---------------------------------------------------------------- KV 记录读写 */

/** 剥离 PII，得到可以放在境外的 KV 副本（判额度只需要这两项） */
export function sanitizeRecordForKv(rec) {
  return {
    timestamps: Array.isArray(rec?.timestamps) ? rec.timestamps : [],
    subscription: rec?.subscription || null,
  };
}

/* ------------------------------------------------- 额度记录：境内 Mongo（Node） */

/*
 * 2026-10-26：额度的唯一写入方改成境内 Node（Mongo `client_quota`）。
 *
 * 为什么改：额度判定只有 Pages 能读，导致 `/api/chat` 与 `/api/quota` 必须跑在境外，
 * 客户端每次调用都跨境（实测 P50 641ms / P95 6.7s）。搬到 Mongo 后这两个接口改由本机 Node 提供。
 *
 * 但**付款开通仍在本侧**（`activatePayment` 由微信回调与运营台调用），
 * 所以这里必须改成写 Node —— 否则会出现"钱付了、会员没开通"。
 *
 * 未配置 NODE_API_BASE 时（本地调试/降级）仍然用 KV，行为与改造前一致。
 */
const RECORD_TIMEOUT_MS = 1500;

async function loadRecordViaNode(env, clientId) {
  const cfg = nodeConfig(env);
  if (!cfg) return null;
  try {
    const res = await fetch(`${cfg.base}/v1/admin/client-quota/${encodeURIComponent(clientId)}`, {
      headers: { 'X-Admin-Key': cfg.adminKey, 'User-Agent': 'qtvq-quota/1.0 (+https://qtvq.cn)' },
      signal: AbortSignal.timeout(RECORD_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[quota] 读取境内额度失败 ${clientId} HTTP ${res.status}`);
      return null;
    }
    const j = await res.json().catch(() => null);
    const d = j?.data;
    if (!d) return null;
    return {
      timestamps: Array.isArray(d.timestamps) ? d.timestamps : [],
      subscription: d.subscription || null,
    };
  } catch (err) {
    console.error('[quota] 读取境内额度异常：', err?.message || err);
    return null;
  }
}

async function saveRecordViaNode(env, clientId, rec) {
  const cfg = nodeConfig(env);
  if (!cfg) return false;
  try {
    const res = await fetch(`${cfg.base}/v1/admin/client-quota/${encodeURIComponent(clientId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': cfg.adminKey,
        'User-Agent': 'qtvq-quota/1.0 (+https://qtvq.cn)',
      },
      body: JSON.stringify({
        timestamps: Array.isArray(rec?.timestamps) ? rec.timestamps : [],
        subscription: rec?.subscription || null,
      }),
      signal: AbortSignal.timeout(RECORD_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[quota] 写入境内额度失败 ${clientId} HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[quota] 写入境内额度异常：', err?.message || err);
    return false;
  }
}
/** 热路径：额度记录（境内 Node 权威，KV 仅作降级） */
async function loadRecord(env, clientId) {
  // 境内 Node 是权威来源；读不到（异常/未配置）才回退 KV，避免整站不可用
  const viaNode = await loadRecordViaNode(env, clientId);
  if (viaNode) return viaNode;
  const kv = getKv(env);
  if (kv) {
    const raw = await kv.get(kvKey(clientId));
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        return {
          timestamps: Array.isArray(parsed.timestamps) ? parsed.timestamps : [],
          subscription: parsed.subscription || null,
        };
      } catch (err) {
        // ⚠️ 这里以前是静默 `return defaultClient()`，后果比"读失败"严重得多：
        // 记录损坏 → 被当成全新用户（订阅在内存里消失）→ 紧接着任何一次
        // saveRecord 都会把这个"默认记录"写回去，**原始损坏数据被永久覆盖**。
        // 一个付费会员可能因此变成免费用户，而且日志里什么线索都没有。
        // 现在：① 大声报错；② 把原始内容另存到隔离键，便于事后人工恢复；③ 才返回默认值。
        console.error(`[quota] 客户端记录损坏，已隔离原文：clientId=${clientId}`, err?.message || err);
        try {
          await kv.put(`corrupt:client:${clientId}`, raw, { expirationTtl: 30 * 24 * 3600 });
        } catch (quarantineErr) {
          console.error('[quota] 隔离损坏记录失败（原文可能被后续写入覆盖）：', quarantineErr);
        }
        return { timestamps: [], subscription: null };
      }
    }
    return { timestamps: [], subscription: null };
  }
  if (!memory.has(clientId)) memory.set(clientId, defaultClient());
  const rec = memory.get(clientId);
  return { timestamps: rec.timestamps, subscription: rec.subscription };
}

/** 写额度记录：境内 Node 权威；写成功就不再写 KV（否则两处数据会分叉） */
async function saveRecord(env, clientId, rec) {
  const safe = sanitizeRecordForKv(rec);
  if (await saveRecordViaNode(env, clientId, safe)) {
    try {
      const { backupClientRecord } = await import('./oss-backup.js');
      // 备份同样只送脱敏副本：OSS 虽在境内，但没必要多存一份 PII
      await backupClientRecord(env, clientId, safe);
    } catch {
      /* OSS 未配置时不阻塞主流程 */
    }
    return;
  }
  const kv = getKv(env);
  if (kv) {
    await kv.put(kvKey(clientId), JSON.stringify(safe));
  } else {
    const cur = memory.get(clientId) || defaultClient();
    memory.set(clientId, { ...cur, ...safe });
  }
  try {
    const { backupClientRecord } = await import('./oss-backup.js');
    // 备份同样只送脱敏副本：OSS 虽在境内，但没必要多存一份 PII
    await backupClientRecord(env, clientId, safe);
  } catch {
    /* OSS 未配置时不阻塞主流程 */
  }
}

function prune(ts, now) {
  const cutoff = now - WINDOW_MS;
  return ts.filter((t) => t > cutoff);
}

function buildQuota(rec, now = Date.now()) {
  rec.timestamps = prune(rec.timestamps || [], now);
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
    // 缘值充值待核实（与会员待核实分开，见 submitTopup 注释）
    topupPending: rec.topupPending || null,
    paymentHistory: rec.paymentHistory || [],
    plans: PLANS,
  };
}

/**
 * 注销账号时清除该设备的配额 / 订阅 / 付款明细记录。
 * 订单本身不删：由 functions/api/auth/delete.js 脱敏保留（业务方 2026-09-16 决定）。
 */
export async function clearClientRecord(env, clientId) {
  if (!validClientId(clientId)) return false;
  const kv = getKv(env);
  if (kv) await kv.delete(kvKey(clientId));
  memory.delete(clientId);
  const cfg = nodeConfig(env);
  if (cfg) {
    try {
      await fetch(`${cfg.base}/v1/admin/client-billing/${encodeURIComponent(clientId)}`, {
        method: 'DELETE',
        headers: { 'X-Admin-Key': cfg.adminKey, 'User-Agent': 'qtvq-billing/1.0 (+https://qtvq.cn)' },
        signal: AbortSignal.timeout(BILLING_TIMEOUT_MS),
      });
    } catch (err) {
      console.error('[quota] 删除境内 billing 失败（不阻塞注销）：', err?.message || err);
    }
  }
  return true;
}

export function validClientId(clientId) {
  return clientId && typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 64;
}

/**
 * @param {object} env
 * @param {string} clientId
 * @param {{withBilling?: boolean}} opts  `withBilling: false` 用于热路径（每次提问判额度），
 *        此时不读境内明细，响应里的 paymentPending/paymentHistory 为 undefined。
 */
export async function getQuota(env, clientId, { withBilling = true } = {}) {
  if (!validClientId(clientId)) return null;
  const rec = await loadRecord(env, clientId);
  let billing = null;
  if (withBilling) billing = await loadBilling(env, clientId);
  const q = buildQuota({ ...rec, paymentPending: null, topupPending: null, paymentHistory: [], ...(billing || {}) });
  q.storage = getKv(env) ? 'kv+mongo' : 'memory';
  return q;
}

export async function canAsk(env, clientId, followUp) {
  if (followUp) return { ok: true };
  // 热路径：不读境内 billing，只读 KV 的 timestamps/subscription
  const q = await getQuota(env, clientId, { withBilling: false });
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
  const pending = {
    plan: data.plan,
    planLabel: plan.label,
    amount: plan.price,
    payerName: data.payerName,
    paidAt: data.paidAt,
    remark: data.remark,
    phone: data.phone || null,
    status: 'pending',
    submittedAt: Date.now(),
    clientId,
  };
  const saved = await saveBilling(env, clientId, { paymentPending: pending });
  if (!saved.ok) {
    // 明细写不进去就等于"登记了但没人能看到"，必须让调用方知道
    console.error('[quota] 付款登记未能落地境内：', clientId, saved.reason);
    return { error: `付款登记未能保存（${saved.reason}），请重试或联系客服` };
  }
  return pending;
}

/**
 * 缘值充值（任意金额）的待核实登记。
 *
 * 为什么单独一个字段而不是复用 `paymentPending`：
 * 会员待核实会被运营台的「核实并开通」用 `activatePayment(clientId, plan)` 处理，
 * 若把充值和会员混在同一字段，充值时就会走"开通套餐"的逻辑（或被它误判），
 * 充值没有套餐价、也不该开通会员 —— 所以彻底分开，互不影响。
 *
 * 到账仍由运营人工核对（静态收款码没有回调），运营在运营台按这份登记给用户钱包入账。
 */
export const TOPUP_MIN = 1;
export const TOPUP_MAX = 2000;

export async function submitTopup(env, clientId, data) {
  if (!validClientId(clientId)) return null;
  const amount = Number(data.amount);
  if (!Number.isFinite(amount) || amount < TOPUP_MIN) return { error: `充值金额至少 ¥${TOPUP_MIN}` };
  if (amount > TOPUP_MAX) return { error: `单次充值不得超过 ¥${TOPUP_MAX}，大额请对公汇款` };
  // 只接受两位小数，避免 1.999 这类金额造成核对困难
  if (Math.round(amount * 100) !== Math.round(amount * 100 * 100) / 100) return { error: '金额最多两位小数' };

  const pending = {
    amount: Math.round(amount * 100) / 100,
    payerName: data.payerName,
    paidAt: data.paidAt,
    remark: data.remark,
    phone: data.phone || null,
    status: 'pending',
    submittedAt: Date.now(),
    clientId,
  };
  const saved = await saveBilling(env, clientId, { topupPending: pending });
  if (!saved.ok) {
    console.error('[quota] 充值登记未能落地境内：', clientId, saved.reason);
    return { error: `充值登记未能保存（${saved.reason}），请重试或联系客服` };
  }
  return pending;
}

export async function activatePayment(env, clientId, planId) {
  const plan = PLANS[planId];
  if (!plan || !validClientId(clientId)) return false;

  const billing = (await loadBilling(env, clientId)) || {};
  const patch = {};
  if (billing.paymentPending) {
    // history 只保留最近 20 条，避免无限增长
    patch.paymentHistory = [
      { ...billing.paymentPending, status: 'active', activatedAt: Date.now() },
      ...(Array.isArray(billing.paymentHistory) ? billing.paymentHistory : []),
    ].slice(0, 20);
    patch.paymentPending = null;
  }

  // 订阅在 KV（非 PII，热路径要读）
  const rec = await loadRecord(env, clientId);
  const base = Math.max(Date.now(), rec.subscription?.activeUntil || 0);
  rec.subscription = {
    plan: planId,
    label: plan.label,
    activeUntil: base + plan.days * 24 * 60 * 60 * 1000,
    activatedAt: Date.now(),
  };
  await saveRecord(env, clientId, rec);

  if (Object.keys(patch).length) {
    const saved = await saveBilling(env, clientId, patch);
    if (!saved.ok) {
      /*
       * 会员已经在 KV 侧开通、但"待核实"没清掉 → 运营台会继续显示待核实。
       * 不让它变成静默问题：明确返回失败，由调用方提示运营人工清理。
       */
      console.error('[quota] 会员已开通但境内明细未同步：', clientId, saved.reason);
      return false;
    }
  }
  return true;
}

/** 工作人员：列出待核实汇款（走境内 Mongo 查询，不再全量扫 KV） */
export async function listPendingPayments(env) {
  const cfg = nodeConfig(env);
  if (cfg) {
    try {
      const res = await fetch(`${cfg.base}/v1/admin/client-billing?pending=payment`, {
        headers: { 'X-Admin-Key': cfg.adminKey, 'User-Agent': 'qtvq-billing/1.0 (+https://qtvq.cn)' },
        signal: AbortSignal.timeout(BILLING_TIMEOUT_MS),
      });
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        const items = (j?.data?.items || [])
          .filter((x) => x.paymentPending?.status === 'pending')
          .map((x) => ({ clientId: x.clientId, ...x.paymentPending }))
          .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
        return { items, storage: 'mongo-cn' };
      }
      console.error('[quota] 待核实列表读取失败 HTTP', res.status);
    } catch (err) {
      console.error('[quota] 待核实列表读取异常：', err?.message || err);
    }
  }

  // 未配置境内的部署（或境内不可用）：退回内存/KV 扫描，行为同改造前
  const kv = getKv(env);
  if (!kv) {
    const items = [];
    for (const [id, rec] of memory.entries()) {
      if (rec.paymentPending?.status === 'pending') items.push({ clientId: id, ...rec.paymentPending });
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
        items.push({ clientId: name.slice(KV_PREFIX.length), ...rec.paymentPending });
      }
    } catch {
      /* skip */
    }
  }
  items.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
  return { items, storage: 'kv-legacy' };
}

export { PLANS, DAILY_ASK_LIMIT };
