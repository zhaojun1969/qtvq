/**
 * P2 出口自检：三种报告（避坑诊断 / 关系复盘 / 配对合盘）**真实付费跑通**
 *
 * 与 `e2e-billing-safety.mjs` 的分工：
 *   · 那个脚本用内存 Mongo 验证"计费状态机"的边界（余额不足、重放、退款…）；
 *   · 这个脚本验证 P2 的**商品链路**：402 门槛 → 订单支付 → 生成 → 分享 token → 公开分享页，
 *     并且要求**真模型出真内容**（三段齐全、完整度达标），所以它默认连真实 Mongo + 真实网关。
 *
 * 为什么订单不用 HTTP 建：本机没有微信商户号（server/.env 缺 WECHAT_* 六项），
 * 走不了 `/v1/payment/wechat/create`。这里直接调用 `services/orders.js` 的
 * `createOrder` / `markPaid` —— 正是支付回调验签通过后调用的同两个函数
 * （验签本身由 `scripts/test-wechat-pay.mjs` 用真实 AES-GCM 报文单独验证）。
 *
 * 用法（必须在 server/ 目录下，且能找到 .env）：
 *   cd /opt/qtvq/server
 *   MONGO_DB=qtvq_e2e_report PORT=3999 ENFORCE_REPORT_BILLING=1 ALLOW_DEV_LOGIN=1 \
 *     node --env-file=.env scripts/e2e-report-skus.mjs            # 全量
 *     node ... --only=diagnose                                    # 只跑一个
 *     node ... --drop                                             # 跑完删掉自建的测试库
 *
 * 安全：脚本只写自己建的测试库（MONGO_DB 必须是 `*_e2e*`，否则直接拒绝运行），
 * 不会碰生产库的 reports / orders。
 */
import process from 'node:process';

const PORT = Number(process.env.PORT || 3999);
const BASE = `http://127.0.0.1:${PORT}`;
const MONGO_DB = String(process.env.MONGO_DB || '');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;
const DROP = process.argv.includes('--drop');
const RUN = `e2e${Date.now().toString(36)}`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
  return ok;
}

async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  const data = json && typeof json === 'object' && 'data' in json ? json.data : json;
  return { status: res.status, data, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReport(token, reportId, { timeoutMs = 180000 } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const r = await req('GET', `/v1/report/${reportId}`, { token });
    last = r;
    const st = r.data?.status;
    if (st === 'ready' || st === 'failed') return r;
    await sleep(1200);
  }
  return last;
}

/** 一个"填好资料 + 已过年龄门"的测试用户 */
async function makeUser(uid, { nickname, gender, age, tags } = {}) {
  const login = await req('POST', '/v1/auth/dev-login', { body: { uid } });
  const token = login.data?.token;
  if (!token) throw new Error(`dev-login 失败：${JSON.stringify(login.json)}`);
  const prof = await req('PATCH', '/v1/profile/me', {
    token,
    body: {
      nickname: nickname || uid,
      gender: gender || 'female',
      age: age || 29,
      city: '北京',
      tags: tags || ['性格沟通', '边界感'],
      intro: '端到端自检用资料，喜欢安静和长跑',
    },
  });
  if (prof.status !== 200) throw new Error(`填资料失败：${JSON.stringify(prof.json)}`);
  const adult = await req('POST', '/v1/profile/adult', { token, body: { birthYear: new Date().getFullYear() - (age || 29) } });
  if (adult.status !== 200) throw new Error(`年龄门失败：${JSON.stringify(adult.json)}`);
  return { uid, token };
}

/** 走真实订单：createOrder → markPaid（= 支付回调验签通过后的那两步） */
async function payFor({ uid, sku, amountFen }) {
  const { createOrder, markPaid } = await import('../src/services/orders.js');
  const order = await createOrder({ uid, sku, amountFen, channel: 'wechat', meta: { e2e: RUN } });
  const paid = await markPaid({ orderId: order.orderId, transactionId: `wx_e2e_${order.orderId}`, amountFen });
  return { orderId: order.orderId, paid };
}

/** 单个商品的完整链路断言 */
async function runSku({ sku, user, payload, expectPriceFen, expectTier }) {
  console.log(`\n──────── ${sku} ────────`);

  // 1) 未支付 → 402，且价格符合预期（含首单价）
  const gate = await req('POST', '/v1/report/generate', { token: user.token, body: { sku, ...payload, idempotencyKey: `${RUN}-${sku}-gate` } });
  check(
    `[${sku}] 未支付被 402 拦下`,
    gate.status === 402 && (gate.json?.code === 'E_NEED_PAY' || gate.data?.code === 'E_NEED_PAY'),
    `HTTP ${gate.status} priceFen=${gate.json?.priceFen}`,
  );
  if (expectPriceFen != null) {
    check(`[${sku}] 报价 = ${expectPriceFen} 分`, Number(gate.json?.priceFen) === expectPriceFen, `实际 ${gate.json?.priceFen}`);
  }
  const priceFen = Number(gate.json?.priceFen || expectPriceFen || 0);

  // 2) 支付（订单 + 回调同一套服务函数）
  const { orderId, paid } = await payFor({ uid: user.uid, sku, amountFen: priceFen });
  check(`[${sku}] 订单入账`, !!paid?.settled, `${orderId} credited=${paid?.credited}`);

  // 3) 带订单再下单 → 200 pending → 轮询到 ready
  const t0 = Date.now();
  const gen = await req('POST', '/v1/report/generate', {
    token: user.token,
    body: { sku, ...payload, orderId, idempotencyKey: `${RUN}-${sku}-paid` },
  });
  check(`[${sku}] 支付后可下单`, gen.status === 200, `HTTP ${gen.status} ${gen.status === 200 ? '' : JSON.stringify(gen.json).slice(0, 160)}`);
  const reportId = gen.data?.reportId;
  if (!reportId) return false;
  check(`[${sku}] 返回 pending 不阻塞`, gen.data?.status === 'pending' || gen.data?.status === 'ready', `status=${gen.data?.status}`);

  const done = await waitReport(user.token, reportId);
  const doc = done.data || {};
  const took = ((Date.now() - t0) / 1000).toFixed(1);
  check(`[${sku}] 生成完成（${took}s）`, doc.status === 'ready', `status=${doc.status} llmError=${doc.llmError || '-'}`);
  if (doc.status !== 'ready') return false;

  check(`[${sku}] kind 正确`, doc.kind === sku, `kind=${doc.kind}`);
  check(`[${sku}] tier 正确`, doc.tier === (expectTier || undefined) || doc.tier === expectTier, `tier=${doc.tier}`);

  const sec = doc.sections || {};
  if (sku === 'pair') {
    check(`[${sku}] 有评分`, typeof doc.overall === 'number' || !!doc.scores, `overall=${doc.overall}`);
    check(`[${sku}] 有正文`, String(doc.content || '').length > 200, `${String(doc.content || '').length} 字`);
  } else {
    check(`[${sku}] 风险点 ≥1`, (sec.risks || []).length >= 1, `${(sec.risks || []).length} 条`);
    check(`[${sku}] 对照案例 ≥1`, (sec.cases || []).length >= 1, `${(sec.cases || []).length} 条`);
    check(`[${sku}] 行动清单 ≥1`, (sec.actions || []).length >= 1, `${(sec.actions || []).length} 条`);
    check(`[${sku}] 完整度 ≥0.5`, Number(doc.completeness || 0) >= 0.5, `completeness=${doc.completeness}`);
    check(`[${sku}] 无兜底拼接`, !doc.fallback, `fallback=${!!doc.fallback}`);
  }

  // 4) 订单必须被消费掉（否则等于白送 / 可重复使用）
  const { getOrder } = await import('../src/services/orders.js');
  const after = await getOrder(orderId);
  check(`[${sku}] 订单已消费`, after?.status === 'consumed', `status=${after?.status}`);

  // 5) 分享 token + 公开分享页（不带登录态）
  const share = await req('POST', `/v1/report/${reportId}/share`, { token: user.token });
  const token = share.data?.token || share.data?.shareToken;
  check(`[${sku}] 生成分享 token`, !!token, `shortPath=${share.data?.shortPath}`);
  if (token) {
    const pub = await req('GET', `/v1/report/share/${token}`);
    const p = pub.data || {};
    check(`[${sku}] 公开分享页可取`, pub.status === 200, `HTTP ${pub.status}`);
    check(`[${sku}] 分享页带 kind/摘要`, p.kind === sku && !!p.summary, `kind=${p.kind} summary=${String(p.summary || '').slice(0, 18)}…`);
    check(`[${sku}] 分享页不泄漏快照`, !('meSnapshot' in p) && !('targetSnapshot' in p) && !('content' in p), '仅结论+条目');
    check(`[${sku}] 分享页记录邀请人`, !!p.inviterUid, `inviter=${p.inviterUid}`);
    check(`[${sku}] shortPath 形状`, /^\/r\/[A-Za-z0-9_-]{12,64}$/.test(String(share.data?.shortPath || '')), String(share.data?.shortPath));
  }

  return true;
}

async function main() {
  if (!/e2e/i.test(MONGO_DB)) {
    console.error(`拒绝运行：MONGO_DB="${MONGO_DB}" 不是测试库。请显式传 MONGO_DB=qtvq_e2e_xxx。`);
    process.exit(2);
  }
  process.env.ALLOW_DEV_LOGIN = '1';
  process.env.ENFORCE_REPORT_BILLING = '1';
  process.env.PORT = String(PORT);

  console.log('== P2 出口自检：三种报告真实付费链路 ==');
  console.log(`  端口 ${PORT} · 库 ${MONGO_DB} · 开关 ENFORCE_REPORT_BILLING=1\n`);

  const { connectDB, closeDB, getDB } = await import('../src/config/db.js');
  await import('../src/app.js');
  await connectDB();

  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    try {
      const r = await req('GET', '/v1/health');
      ready = r.status === 200;
    } catch {
      /* retry */
    }
    if (!ready) await sleep(400);
  }
  if (!ready) {
    console.error('服务未启动');
    process.exit(1);
  }

  const db = getDB();
  /*
   * 判据依赖真实避坑案例：diagnose 的三段里「对照案例」是 RAG 检索出来的。
   * 测试库是新的，自然没有案例 —— 与其跑出一个"案例为空"的假失败，
   * 不如从生产库**只读**复制一份案例（含向量），测完随 --drop 一起删掉。
   */
  let pitCount = await db.collection('pitfalls').countDocuments();
  if (pitCount === 0) {
    const seedFrom = String(process.env.SEED_FROM_DB || 'qtvq');
    const { MongoClient } = await import('mongodb');
    const seedClient = new MongoClient(process.env.MONGO_URI);
    await seedClient.connect();
    try {
      const docs = await seedClient.db(seedFrom).collection('pitfalls').find({}).limit(600).toArray();
      if (docs.length) {
        await db.collection('pitfalls').insertMany(docs, { ordered: false });
        console.log(`  测试库为空 → 从 ${seedFrom}.pitfalls 只读复制 ${docs.length} 条案例`);
      }
    } catch (e) {
      console.warn(`  复制案例失败（${String(e?.message || e).slice(0, 80)}），继续`);
    } finally {
      await seedClient.close();
    }
    pitCount = await db.collection('pitfalls').countDocuments();
  }
  console.log(`  避坑案例库：${pitCount} 条`);
  if (pitCount === 0) {
    console.warn('  ⚠️ 空库：diagnose 的对照案例会缺料，请先用 import-pitfalls.mjs 导入');
  }

  const me = await makeUser(`u_${RUN}_me`, { nickname: '自检乙', gender: 'female', age: 29 });
  const ta = await makeUser(`u_${RUN}_ta`, { nickname: '自检甲', gender: 'male', age: 31, tags: ['成就感', '理性'] });

  const plan = [
    {
      sku: 'diagnose',
      user: me,
      expectPriceFen: 490, // 首单特价：每个账号一次
      expectTier: 'advanced',
      payload: {
        description:
          '在一起八个月，异地上班。最近一个月她回消息越来越慢，周末也常说累不想视频；我一提以后的事她就换话题。',
        scenes: ['cold', 'long_distance'],
        question: '她是不是在等我先提分手？',
      },
    },
    {
      sku: 'retro',
      user: me,
      expectPriceFen: 1990,
      expectTier: 'deep',
      payload: {
        selfView: '我总觉得她变了，所以不停追问，她一沉默我就更慌，最后变成我道歉。',
        partnerView: '她说她一开口就变成我的审讯，说什么都会被拿来当证据，所以干脆不说了。',
        history: '5 月第一次因为「回消息慢」吵架；7 月她提出冷静两周；9 月开始分房睡。',
        question: '还有救吗，还是要止损？',
      },
    },
    {
      sku: 'pair',
      user: me,
      expectPriceFen: 2990,
      expectTier: 'deep',
      payload: { targetUid: ta.uid, question: '我们适合长期吗？' },
    },
  ].filter((x) => !ONLY || x.sku === ONLY);

  let passed = 0;
  for (const item of plan) {
    const okRun = await runSku(item).catch((e) => {
      check(`[${item.sku}] 未预期异常`, false, String(e?.message || e).slice(0, 200));
      return false;
    });
    if (okRun) passed += 1;
  }

  // 首单价只能用一次：同一账号再买 diagnose 应恢复 990
  if (!ONLY || ONLY === 'diagnose') {
    console.log('\n──────── 首单价一次性 ────────');
    const again = await req('POST', '/v1/report/generate', {
      token: me.token,
      body: { sku: 'diagnose', description: '再测一次首单价是否还在（这段文字只是为了过 10 字下限）', idempotencyKey: `${RUN}-intro-again` },
    });
    check('[diagnose] 首单价只用一次（现价 990）', Number(again.json?.priceFen) === 990, `HTTP ${again.status} priceFen=${again.json?.priceFen}`);
  }

  // 结果
  const failed = results.filter((r) => !r.ok);
  console.log('\n══════ 汇总 ══════');
  console.log(`  通过 ${results.length - failed.length} · 失败 ${failed.length} · 商品链路 ${passed}/${plan.length}`);
  if (failed.length) {
    console.log('\n失败项：');
    failed.forEach((f) => console.log(`  · ${f.name}${f.detail ? ` —— ${f.detail}` : ''}`));
  }

  if (DROP) {
    await db.dropDatabase();
    console.log(`  已删除测试库 ${MONGO_DB}`);
  }
  await closeDB();
  console.log(failed.length ? '\n❌ 存在失败' : '\n✅ 全部通过');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('自检异常：', e);
  process.exit(1);
});
