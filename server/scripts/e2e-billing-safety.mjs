/**
 * 计费 + 内容安全 + 举报/运营台 端到端自检
 *
 * 钱的部分必须真跑：这里覆盖「不漏扣、不重复扣、失败要退」三条，
 * 以及举报去重、自动隐藏阈值、管理员鉴权与审计留痕。
 *
 * 用法：node scripts/e2e-billing-safety.mjs
 */
import process from 'node:process';

const E2E_PORT = Number(process.env.E2E_PORT || 34569);
const BASE = `http://127.0.0.1:${E2E_PORT}`;
const ADMIN_KEY = 'e2e-admin-key';

const results = [];
let failures = 0;
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failures++;
  console.log(`  ${ok ? '\u2713' : '\u2717'} ${name}${detail ? `  — ${detail}` : ''}`);
}

async function req(method, path, { token, admin, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (admin) headers['X-Admin-Key'] = admin;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, data: json?.data };
}

async function main() {
  let mem;
  try {
    ({ MongoMemoryServer: mem } = await import('mongodb-memory-server'));
  } catch {
    console.error('需要 mongodb-memory-server：npm install --no-save mongodb-memory-server');
    process.exit(2);
  }
  const mongoServer = await mem.create();

  // 必须在 import app 之前设置
  process.env.MONGO_URI = mongoServer.getUri('qtvq_e2e_bill');
  process.env.MONGO_DB = 'qtvq_e2e_bill';
  process.env.PORT = String(E2E_PORT);
  process.env.ALLOW_DEV_LOGIN = '1';
  process.env.JWT_SECRET = 'e2e-bill-secret';
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.ENFORCE_BILLING = '1';
  process.env.WELCOME_BALANCE = '10';
  process.env.FREE_TIERS = 'basic';
  process.env.MEMBER_DAILY_FREE = '1';
  process.env.MODERATION_AUTO_HIDE = '3';
  process.env.SAFETY_PROVIDER = 'local';

  console.log('== 计费 / 内容安全 / 举报 自检 ==');
  console.log(`  端口 ${E2E_PORT} · 赠送余额 ¥10 · basic 免费 · 自动隐藏阈值 3\n`);

  const { connectDB, closeDB, getDB } = await import('../src/config/db.js');
  const { PITFALLS } = await import('../../js/data.js');
  await import('../src/app.js');

  // 等启动
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    try {
      const r = await req('GET', '/v1/health');
      ready = r.status === 200;
    } catch {
      /* retry */
    }
    if (!ready) await new Promise((r) => setTimeout(r, 400));
  }
  if (!ready) {
    console.error('服务未启动');
    await mongoServer.stop();
    process.exit(1);
  }
  await connectDB();
  await getDB()
    .collection('pitfalls')
    .insertMany(
      PITFALLS.slice(0, 10).map((p) => ({ id: p.id, category: p.category, title: p.title, lesson: p.lesson || '', steps: p.steps || '', vector: null, createdAt: new Date() })),
      { ordered: false },
    );

  const tokOf = async (uid) => {
    const r = await req('POST', '/v1/auth/dev-login', { body: { uid } });
    return r.data?.token;
  };

  const A = 'u_bill_a';
  const B = 'u_bill_b';
  const tokA = await tokOf(A);
  const tokB = await tokOf(B);

  const fillProfile = async (token, nickname, tags) => {
    const r = await req('PATCH', '/v1/profile/me', {
      token,
      body: { nickname, gender: 'male', age: 30, city: '北京', tags, intro: '测试用资料，喜欢安静' },
    });
    return r;
  };

  // ---------------------------------------------------------------- 1. 钱包
  console.log('[1] 钱包与报价');
  const w0 = await req('GET', '/v1/wallet', { token: tokA });
  check('新钱包有赠送余额 ¥10', w0.data?.wallet?.balance === 10, `balance=${w0.data?.wallet?.balance}`);
  check('basic 报价为免费', w0.data?.quotes?.basic?.amount === 0 && w0.data?.quotes?.basic?.reason === 'free_tier');
  check('deep 报价为 ¥20', w0.data?.quotes?.deep?.amount === 20, `amount=${w0.data?.quotes?.deep?.amount}`);
  check('响应里带计费开关状态', w0.data?.billing?.enforce === true);

  // ---------------------------------------------------------------- 2. 余额不足
  console.log('\n[2] 余额不足必须拒绝（且不能扣钱）');
  await fillProfile(tokA, '阿哲', ['音乐']);
  await fillProfile(tokB, '小Q', ['音乐']);
  const poor = await req('POST', '/v1/report/generate', { token: tokA, body: { targetUid: B, tier: 'deep', idempotencyKey: 'poor-1' } });
  check('余额不足返回 402', poor.status === 402 && poor.json?.errorCode === 'E_INSUFFICIENT_BALANCE', `status=${poor.status} code=${poor.json?.errorCode}`);
  const wAfterPoor = await req('GET', '/v1/wallet', { token: tokA });
  check('被拒后余额未变', wAfterPoor.data?.wallet?.balance === 10, `balance=${wAfterPoor.data?.wallet?.balance}`);
  const led1 = await req('GET', '/v1/wallet/ledger', { token: tokA });
  check('失败也留痕（status=failed）', led1.data?.items?.some((x) => x.status === 'failed'), JSON.stringify(led1.data?.items?.map((x) => x.status)));

  // ---------------------------------------------------------------- 3. 免费档位
  console.log('\n[3] 免费档位不计费');
  const free = await req('POST', '/v1/report/generate', { token: tokA, body: { targetUid: B, tier: 'basic', idempotencyKey: 'free-1' } });
  check('basic 生成成功', free.status === 200, `status=${free.status}`);
  check('billing.charged = 0 且原因为 free_tier', free.data?.billing?.charged === 0 && free.data?.billing?.reason === 'free_tier', JSON.stringify(free.data?.billing));
  const wAfterFree = await req('GET', '/v1/wallet', { token: tokA });
  check('免费档位不扣余额', wAfterFree.data?.wallet?.balance === 10, `balance=${wAfterFree.data?.wallet?.balance}`);

  // ---------------------------------------------------------------- 4. 管理员充值
  console.log('\n[4] 运营台鉴权与人工充值');
  const noKey = await req('GET', '/v1/admin/overview');
  check('无口令访问运营台 401', noKey.status === 401, `status=${noKey.status}`);
  const badKey = await req('GET', '/v1/admin/overview', { admin: 'wrong' });
  check('错误口令 401', badKey.status === 401, `status=${badKey.status}`);

  const credit1 = await req('POST', `/v1/admin/users/${A}/credit`, { admin: ADMIN_KEY, body: { amount: 50, ref: 'BANK-001' } });
  check('充值成功', credit1.status === 200 && credit1.data?.credited === 50, `credited=${credit1.data?.credited}`);
  check('充值后余额 ¥60', credit1.data?.balance === 60, `balance=${credit1.data?.balance}`);

  const credit2 = await req('POST', `/v1/admin/users/${A}/credit`, { admin: ADMIN_KEY, body: { amount: 50, ref: 'BANK-001' } });
  check('同一汇款单号重复充值只入账一次', credit2.data?.replayed === true && credit2.data?.balance === 60, `replayed=${credit2.data?.replayed} balance=${credit2.data?.balance}`);
  const credit3 = await req('POST', `/v1/admin/users/${A}/credit`, { admin: ADMIN_KEY, body: { amount: -5 } });
  check('负数金额被拒', credit3.status === 400, `status=${credit3.status}`);

  // ---------------------------------------------------------------- 5. 正常扣费
  console.log('\n[5] 正常扣费与幂等');
  const paid1 = await req('POST', '/v1/report/generate', { token: tokA, body: { targetUid: B, tier: 'deep', idempotencyKey: 'pay-1' } });
  check('deep 生成成功', paid1.status === 200, `status=${paid1.status}`);
  check('扣了 ¥20', paid1.data?.billing?.charged === 20, `charged=${paid1.data?.billing?.charged}`);
  check('余额变为 ¥40', paid1.data?.billing?.balance === 40, `balance=${paid1.data?.billing?.balance}`);

  const again = await req('POST', '/v1/report/generate', { token: tokA, body: { targetUid: B, tier: 'deep', idempotencyKey: 'pay-1' } });
  check('同幂等键重复请求被识别为重放', again.data?.billing?.replayed === true, `replayed=${again.data?.billing?.replayed}`);
  check('重放不再扣费', again.data?.billing?.charged === 0, `charged=${again.data?.billing?.charged}`);
  check('重放返回同一份报告', again.data?.reportId === paid1.data?.reportId, `${again.data?.reportId} vs ${paid1.data?.reportId}`);
  const wAfterReplay = await req('GET', '/v1/wallet', { token: tokA });
  check('重放后余额仍为 ¥40', wAfterReplay.data?.wallet?.balance === 40, `balance=${wAfterReplay.data?.wallet?.balance}`);

  // 并发同键：只能成功一次
  console.log('\n[6] 并发同键（防双击重复扣款）');
  const before = (await req('GET', '/v1/wallet', { token: tokA })).data.wallet.balance;
  const [c1, c2, c3] = await Promise.all([
    req('POST', '/v1/report/generate', { token: tokA, body: { targetUid: B, tier: 'deep', idempotencyKey: 'race-1' } }),
    req('POST', '/v1/report/generate', { token: tokA, body: { targetUid: B, tier: 'deep', idempotencyKey: 'race-1' } }),
    req('POST', '/v1/report/generate', { token: tokA, body: { targetUid: B, tier: 'deep', idempotencyKey: 'race-1' } }),
  ]);
  const succ = [c1, c2, c3].filter((x) => x.status === 200);
  const after = (await req('GET', '/v1/wallet', { token: tokA })).data.wallet.balance;
  check('并发同键只扣一次钱', after === before - 20, `before=${before} after=${after}`);
  check('并发请求没有产生多份报告', new Set(succ.map((x) => x.data?.reportId)).size <= 1, `success=${succ.length} uniqueReport=${new Set(succ.map((x) => x.data?.reportId)).size}`);

  // ---------------------------------------------------------------- 7. 内容安全
  console.log('\n[7] 内容安全');
  const badNick = await req('PATCH', '/v1/profile/me', { token: tokB, body: { nickname: '裸聊加微信', gender: 'female', age: 26 } });
  check('涉黄/引流昵称被拒', badNick.status === 400 && badNick.json?.errorCode === 'E_CONTENT_BLOCKED', `status=${badNick.status} code=${badNick.json?.errorCode}`);
  check('返回命中的类别便于提示', Array.isArray(badNick.json?.safety?.categories) && badNick.json.safety.categories.length > 0, JSON.stringify(badNick.json?.safety?.categories));

  const badIntro = await req('PATCH', '/v1/profile/me', { token: tokB, body: { intro: '带你稳赚不赔，加我微信带你上车' } });
  check('诈骗/引流简介被拒', badIntro.status === 400 && badIntro.json?.errorCode === 'E_CONTENT_BLOCKED', `code=${badIntro.json?.errorCode}`);

  const okProfile = await req('PATCH', '/v1/profile/me', { token: tokB, body: { nickname: '小Q', intro: '喜欢安静也喜欢热闹，周末爱逛展' } });
  check('正常资料通过', okProfile.status === 200, `status=${okProfile.status}`);

  // 绕过尝试：插入空格与零宽字符
  const bypass = await req('PATCH', '/v1/profile/me', { token: tokB, body: { nickname: '加 微\u200b信 联系' } });
  check('「加 微 信」+零宽字符绕过仍被拦', bypass.status === 400, `status=${bypass.status}`);

  const badQ = await req('POST', '/v1/report/generate', { token: tokA, body: { targetUid: B, tier: 'basic', question: '怎么玩六合彩', idempotencyKey: 'safe-q-1' } });
  check('涉赌提问被拒', badQ.status === 400 && badQ.json?.errorCode === 'E_CONTENT_BLOCKED', `status=${badQ.status}`);

  const sc = await req('POST', '/v1/safety/check', { token: tokA, body: { text: '我该怎么和对方说', field: 'question' } });
  check('安全预检接口放行正常文本', sc.status === 200 && sc.data?.clean === true);
  const sc2 = await req('POST', '/v1/safety/check', { body: { text: '加微信详聊', field: 'profile' } });
  check('安全预检接口拦下引流', sc2.data?.clean === false && sc2.data?.action === 'block', JSON.stringify(sc2.data?.categories));

  const safetyStatus = await req('GET', '/v1/safety/status');
  check('安全状态显示本地词表已加载', safetyStatus.data?.localWords > 20 && safetyStatus.data?.aliyunGreenImplemented === false, `words=${safetyStatus.data?.localWords}`);

  // ---------------------------------------------------------------- 8. 举报与自动隐藏
  console.log('\n[8] 举报、去重与自动隐藏');
  const rep1 = await req('POST', '/v1/moderation/report', { token: tokB, body: { targetType: 'user', targetId: A, reason: '虚假资料', detail: '资料疑似盗图' } });
  check('举报提交成功', rep1.status === 200 && rep1.data?.status === 'pending', `status=${rep1.status}`);
  const rep2 = await req('POST', '/v1/moderation/report', { token: tokB, body: { targetType: 'user', targetId: A, reason: '虚假资料' } });
  check('同人同日重复举报被去重', rep2.data?.duplicate === true, `duplicate=${rep2.data?.duplicate}`);
  const repSelf = await req('POST', '/v1/moderation/report', { token: tokB, body: { targetType: 'user', targetId: B, reason: '其他' } });
  check('不能举报自己', repSelf.status === 400 && repSelf.json?.errorCode === 'E_SELF_REPORT');
  const repBad = await req('POST', '/v1/moderation/report', { token: tokB, body: { targetType: 'user', targetId: A, reason: '随便写的原因' } });
  check('非法举报原因被拒', repBad.status === 400 && repBad.json?.errorCode === 'E_BAD_REASON');

  const myRep = await req('GET', '/v1/moderation/mine', { token: tokB });
  check('可查看自己的举报', myRep.data?.items?.length === 1, `items=${myRep.data?.items?.length}`);

  // 3 个不同举报人 → 触发自动隐藏（阈值设成 3）
  const reporters = ['u_rep_1', 'u_rep_2'];
  for (const uid of reporters) {
    const t = await tokOf(uid);
    // eslint-disable-next-line no-await-in-loop
    await req('POST', '/v1/moderation/report', { token: t, body: { targetType: 'user', targetId: A, reason: '辱骂' } });
  }
  const hiddenUser = await getDB().collection('users').findOne({ _id: A });
  check('达阈值后自动转 invisible（不直接封禁）', hiddenUser?.status === 'invisible', `status=${hiddenUser?.status}`);

  console.log('\n[9] 运营台处置举报');
  const pending = await req('GET', '/v1/admin/moderation?status=pending', { admin: ADMIN_KEY });
  check('运营台能看到待处理举报', (pending.data?.items?.length || 0) >= 3, `items=${pending.data?.items?.length}`);
  check('待处理里带举报人与补充说明', !!pending.data?.items?.[0]?.reporterUid && 'detail' in (pending.data?.items?.[0] || {}));

  const target = pending.data.items[0];
  const handled = await req('POST', `/v1/admin/moderation/${target.id}/handle`, { admin: ADMIN_KEY, body: { action: 'approve', note: '经核实资料确实造假' } });
  check('认定举报后生效', handled.data?.status === 'approved' && handled.data?.effect === 'user_banned', JSON.stringify(handled.data));

  const rehandle = await req('POST', `/v1/admin/moderation/${target.id}/handle`, { admin: ADMIN_KEY, body: { action: 'reject' } });
  check('已处理的举报不能重复处置', rehandle.status === 400 && rehandle.json?.errorCode === 'E_ALREADY_HANDLED', `status=${rehandle.status}`);

  const banned = await getDB().collection('users').findOne({ _id: A });
  check('举报成立后用户被封禁', banned?.status === 'banned', `status=${banned?.status}`);

  const audit = await req('GET', '/v1/admin/audit?limit=20', { admin: ADMIN_KEY });
  const actions = (audit.data?.items || []).map((x) => x.action);
  check('审计日志记录了处置动作', actions.includes('approve_report'), actions.join(','));
  check('审计日志记录了自动隐藏', actions.includes('auto_hide_user'), actions.join(','));
  check('审计日志记录了人工充值', actions.includes('credit_user'), actions.join(','));

  console.log('\n[10] 运营台用户与流水视图');
  const users = await req('GET', '/v1/admin/users?q=u_bill&limit=10', { admin: ADMIN_KEY });
  check('用户列表不含向量字段', (users.data?.items || []).every((u) => !('profileVector' in u) && !('introVector' in u)));
  check('用户列表带 hasVector 标记', (users.data?.items || []).every((u) => 'hasVector' in u));
  check('用户列表带余额', (users.data?.items || []).some((u) => typeof u.balance === 'number'));

  const detail = await req('GET', `/v1/admin/users/${A}`, { admin: ADMIN_KEY });
  check('用户详情返回钱包与流水', !!detail.data?.wallet && Array.isArray(detail.data?.ledger), `ledger=${detail.data?.ledger?.length}`);

  const ledger = await req('GET', '/v1/admin/ledger?limit=50', { admin: ADMIN_KEY });
  check('全局流水可读', (ledger.data?.items?.length || 0) > 0, `items=${ledger.data?.items?.length}`);
  check('流水含支出与入账两类', new Set((ledger.data?.items || []).map((x) => x.direction)).size >= 2);

  const mod2 = await req('GET', '/v1/admin/users/' + A + '/status', { admin: ADMIN_KEY });
  check('不支持的方法返回 404', mod2.status === 404, `status=${mod2.status}`);

  const console_ = await req('GET', '/v1/admin/console');
  check('运营台页面可直接打开（页面本身不含口令）', console_.status === 200, `status=${console_.status}`);

  // ---------------------------------------------------------------- 汇总
  console.log('\n[11] 清理');
  const db = getDB();
  await db.collection('users').deleteMany({});
  await db.collection('reports').deleteMany({});
  await db.collection('wallet').deleteMany({});
  await db.collection('wallet_ledger').deleteMany({});
  await db.collection('moderation').deleteMany({});
  await db.collection('audit_logs').deleteMany({});
  check('清理完成', true);
  await db.dropDatabase();
  await closeDB();
  await mongoServer.stop();

  const passed = results.length - failures;
  console.log('\n' + '='.repeat(64));
  console.log(`结果：${passed}/${results.length} 通过`);
  console.log('='.repeat(64));
  if (failures) {
    console.log('\n失败项：');
    for (const x of results.filter((y) => !y.ok)) console.log(`  \u2717 ${x.name}${x.detail ? `  — ${x.detail}` : ''}`);
    process.exit(1);
  }
  console.log('全部通过 \u2705');
  process.exit(0);
}

main().catch((err) => {
  console.error('自检异常:', err);
  process.exit(1);
});
