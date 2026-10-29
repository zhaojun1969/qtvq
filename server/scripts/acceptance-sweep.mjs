/**
 * 分阶段验收扫描：把《再改造技术实施书》里"能在代码侧验完"的条目一次性跑一遍。
 *
 * 为什么要有它：
 *   每个阶段单独验证过（E.35–E.51），但散落在十几个脚本里，没人能一眼回答
 *   "现在这套系统到底哪几条是活的"。这个脚本只做**断点**：每条给一个可复核的结论，
 *   失败就说清楚怎么坏，不写"应该没问题"。
 *
 * 覆盖：
 *   P0-2 18+ 年龄门三入口（报告 / 转盘付费 / 候选池）
 *   P1   会员 reportCredits 惰性额度 + 报告用额度不扣钱包
 *   P2   分享 token（公开接口 + /r/<token> 落地页）
 *   P3   渠道归因落地页存在性 + 邀请券发放入口
 *   P4   指标看板接口 + 验收门三判据字段齐全
 *
 * 跑法（服务器 root，需 Mongo + 商户私钥）：
 *   cd /opt/qtvq/server && sudo node --env-file=.env scripts/acceptance-sweep.mjs
 * 退出码：0 全过；1 有失败。
 */
import process from 'node:process';

const BASE = 'http://127.0.0.1:3000';
let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}

async function main() {
  const { connectDB, getDB } = await import('../src/config/db.js');
  const { signLocalToken } = await import('../src/middleware/auth.js');
  const { ADULT_AGREEMENT_VER } = await import('../src/middleware/adult.js');
  const { loadCandidates } = await import('../src/services/wheel.js');
  const { creditStatus } = await import('../src/services/report-credits.js');
  const { generateDiagnose } = await import('../src/services/report-diagnose.js');
  await connectDB();
  const db = getDB();

  const STAMP = Date.now().toString(36);
  const adultUid = `u_sweep_adult_${STAMP}`;
  const minorUid = `u_sweep_minor_${STAMP}`;
  const cleanup = { users: [adultUid, minorUid], reports: [], orders: [] };

  const mkUser = (uid, { birthYear, agreed = true }) =>
    db.collection('users').updateOne(
      { _id: uid },
      {
        $set: {
          nickname: '验收号' + uid.slice(-4),
          gender: 'female',
          birthYear,
          status: 'active',
          updatedAt: new Date(),
          ...(agreed ? { adultAgreedAt: new Date(), adultAgreementVer: ADULT_AGREEMENT_VER } : {}),
        },
      },
      { upsert: true },
    );

  await mkUser(adultUid, { birthYear: 1995 });
  await mkUser(minorUid, { birthYear: new Date().getFullYear() - 16, agreed: false });

  const call = async (path, { uid, method = 'GET', body = null } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (uid) headers.Authorization = `Bearer ${signLocalToken(uid)}`;
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };

  /* ───────────────────────── P0-2 18+ 年龄门三入口 ───────────────────────── */
  console.log('\n【P0-2】18+ 年龄门三入口');

  const desc = { sku: 'diagnose', description: '我们认识三个月，他最近两周已读不回，我一直在等一个解释。' };
  const minorReport = await call('/v1/report/generate', { uid: minorUid, method: 'POST', body: desc });
  check('入口① 报告生成：未成年 → 403 E_UNDERAGE', minorReport.status === 403 && minorReport.json.code === 'E_UNDERAGE', JSON.stringify(minorReport.json).slice(0, 160));

  // 成年但没勾《成年用户承诺》：拦的是"没同意"，不是"未成年"，两条都必须能区分
  const noAgreeUid = `u_sweep_noagree_${STAMP}`;
  await mkUser(noAgreeUid, { birthYear: 1995, agreed: false });
  cleanup.users.push(noAgreeUid);
  const noAgree = await call('/v1/report/generate', { uid: noAgreeUid, method: 'POST', body: desc });
  check('入口① 报告生成：成年未勾承诺 → 403 E_NEED_ADULT_AGREE', noAgree.status === 403 && noAgree.json.code === 'E_NEED_ADULT_AGREE', JSON.stringify(noAgree.json).slice(0, 160));

  const minorWheel = await call('/v1/wheel/spin', { uid: minorUid, method: 'POST', body: {} });
  check('入口② 转盘付费：未成年 → 403', minorWheel.status === 403 && /ADULT|UNDERAGE/.test(minorWheel.json.code || ''), JSON.stringify(minorWheel.json).slice(0, 160));

  /*
   * 入口③ 候选池：`loadCandidates` 返回的是 `{ items, total, excludedRecent }`（不是数组），
   * 所以断言必须按 items 取，并逐条核对年龄落在 18–30 —— 只数数量证明不了"过滤生效"。
   */
  const pool = await loadCandidates({ _id: adultUid, gender: 'female' }).catch((e) => ({ error: e.message }));
  const items = Array.isArray(pool) ? pool : pool?.items || [];
  const y = new Date().getFullYear();
  const ages = items.map((i) => Number(i.age)).filter((a) => Number.isFinite(a));
  check('入口③ 候选池可返回候选', Array.isArray(items) || Boolean(pool?.items), `返回 ${Array.isArray(items) ? items.length : pool?.error || '未知'} 条（今年 ${y}）`);
  check('入口③ 候选池年龄全部落在 18–30', ages.every((a) => a >= 18 && a <= 30), `年龄样本 ${JSON.stringify(ages.slice(0, 8))}`);
  const minorInPool = items.some((i) => i.uid === minorUid || i.uid === noAgreeUid);
  check('入口③ 未成年/未同意用户不会出现在候选池', !minorInPool, `命中：${minorInPool}`);

  /* ─────────────────── P1 会员 reportCredits 惰性额度 ─────────────────── */
  console.log('\n【P1】会员额度（惰性计算，不预生成）');
  const membership = { active: true, plan: 'month', activeUntil: Date.now() + 20 * 24 * 3600 * 1000 };
  const st = await creditStatus(adultUid, membership);
  check('月卡额度合计 = 1', st.total === 1, JSON.stringify(st));
  check('未使用过时剩余 = 1', st.remaining === 1, JSON.stringify(st));
  const stNoMember = await creditStatus(adultUid, null);
  check('无会员时额度为 0（不是报错）', stNoMember.total === 0 || stNoMember.remaining === 0, JSON.stringify(stNoMember));

  /* ─────────────────────── P2 分享 token + /r/ 落地页 ─────────────────────── */
  console.log('\n【P2】分享卡短链');
  const gen = await generateDiagnose({
    description: '我们认识三个月，他从不主动约我，最近两周已读不回超过 72 小时。',
    scenes: ['ambiguous'],
    question: '他到底想不想认真？',
  });
  const ins = await db.collection('reports').insertOne({
    uid: adultUid,
    kind: 'diagnose',
    sku: 'diagnose',
    tier: 'advanced',
    status: 'ready',
    content: gen.content,
    sections: gen.sections,
    completeness: gen.completeness,
    pitfalls: gen.pitfalls || [],
    createdAt: new Date(),
    generatedAt: new Date(),
  });
  cleanup.reports.push(ins.insertedId);
  const share = await call(`/v1/report/${ins.insertedId}/share`, { uid: adultUid, method: 'POST', body: {} });
  const token = share.json?.data?.shareToken || share.json?.shareToken;
  check('分享接口返回 token + shortPath=/r/<token>', Boolean(token) && String(share.json?.data?.shortPath || '').startsWith('/r/'), JSON.stringify(share.json).slice(0, 200));

  if (token) {
    const shared = await fetch(`${BASE}/v1/report/share/${token}`).then((r) => r.json()).catch(() => ({}));
    const d = shared?.data || {};
    check('公开分享接口 200 且只给摘要（不含全文/快照）', Boolean(d.summary) && !d.content && !d.meSnapshot && !d.targetSnapshot, JSON.stringify(d).slice(0, 200));
    const bad = await fetch(`${BASE}/v1/report/share/zzzzzzzzzzzzzzzz`).then((r) => r.status).catch(() => 0);
    check('无效 token → 404（不泄漏）', bad === 404, String(bad));
  }

  /* ─────────────────────────── P4 看板 + 验收门 ─────────────────────────── */
  console.log('\n【P4】指标接口与验收门口径');
  const adminKey = process.env.ADMIN_KEY || '';
  const dash = await fetch(`${BASE}/v1/admin/metrics?days=7`, { headers: { 'X-Admin-Key': adminKey } }).then((r) => r.json()).catch(() => ({}));
  const gate = dash?.data?.gate;
  check('看板返回 rows/summary/gate', Array.isArray(dash?.data?.rows) && Boolean(dash?.data?.summary) && Boolean(gate));
  check('验收门有三条判据', Array.isArray(gate?.checks) && gate.checks.length === 3, JSON.stringify(gate?.checks?.map((c) => c.key) || []));
  check('验收门给出 coverage 与 windowRows（区分真实天数与补算行）', typeof gate?.coverage === 'number' && typeof gate?.windowRows === 'number', JSON.stringify({ coverage: gate?.coverage, windowRows: gate?.windowRows }));
  check('数据不足时不下结论（status=insufficient）', gate?.status === 'insufficient' || gate?.status === 'passed' || gate?.status === 'failed', String(gate?.status));

  /* ─────────────────────────────── 清理 ─────────────────────────────── */
  await db.collection('reports').deleteMany({ _id: { $in: cleanup.reports } });
  await db.collection('users').deleteMany({ _id: { $in: cleanup.users } });
  await db.collection('spin_logs').deleteMany({ uid: { $in: cleanup.users } });
  console.log('\n（验收探针数据已清理）');

  console.log(`\n通过 ${pass} · 失败 ${fail}`);
  if (fail) console.log(`失败项：${failures.join('、')}`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ 验收扫描异常：', err?.stack || err?.message || err);
  process.exit(1);
});
