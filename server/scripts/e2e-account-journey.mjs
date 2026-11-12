/**
 * 账号旅程端到端实测（生产 API 双轨之一：API 轨）
 *
 * 链路：注册 → 登录 → me → 年龄门(成年承诺) → 资料发布(PATCH，含词表安全+向量重算)
 *      → 他人视角查看 → 客服留言 → 找回密码（短信通道探测 + 客服 admin 重置通道）
 *      → 改密 → 注销（密码确认） → 注销后 401 → Mongo 残留复核 → 测试痕迹清理
 *
 * 跨栈必验点：Node(qtvq.cn 同源) 签发的会话，能否被 CF Pages 侧的
 * /api/auth/delete 与 /api/auth/sms 解析（hashKey 共享会话的实测）。
 *
 * 跑法（服务器，ADMIN/PAYMENT_ADMIN_KEY 由 .env 注入，不写死）：
 *   cd /opt/qtvq/server && sudo node --env-file=.env scripts/e2e-account-journey.mjs
 * 退出码：0 全过；1 有失败。
 */
import process from 'node:process';
import { connectDB, getDB } from '../src/config/db.js';

const BASE = process.env.E2E_BASE || 'https://qtvq.cn';
const DIRECTS = ['https://api.qtvq.cn', 'https://qtvq-api.pages.dev']; // 与 js/config.js 同源的候选
const ADMIN_KEY = process.env.PAYMENT_ADMIN_KEY || process.env.ADMIN_KEY || '';
const PHONE = '199' + String(Date.now()).slice(-8); // 11 位合规测试号
const PW1 = 'Journey#e2e' + String(Date.now()).slice(-4);
const PW2 = 'Journey#e2e' + String(Date.now()).slice(-4) + 'x';
const CLIENT_ID = 'e2e_journey_' + Date.now().toString(36);

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
}

async function api(url, { method = 'POST', body, token, admin } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (admin) headers['x-admin-key'] = ADMIN_KEY;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    let json = null;
    try { json = await res.json(); } catch { /* 非 JSON 响应也算数 */ }
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: null, error: String(e.message || e).slice(0, 100) };
  } finally { clearTimeout(t); }
}

async function main() {
  if (!ADMIN_KEY) { console.error('缺 ADMIN_KEY/PAYMENT_ADMIN_KEY（--env-file 注入）'); process.exit(1); }
  await connectDB();
  const db = getDB();
  console.log(`目标：${BASE} ｜ 测试号：${PHONE} ｜ 设备：${CLIENT_ID}\n`);

  // 0. 直接源站连通性探测（js/config.js 的两个候选）
  let direct = null;
  for (const d of DIRECTS) {
    const r = await api(`${d}/api/health`, { method: 'GET' });
    if (r.status === 200) { direct = d; break; }
  }
  check('直连源站可达（api.qtvq.cn 或 pages.dev）', Boolean(direct), '两个候选都不通，CF 侧步骤将失败');

  // 1. 注册
  let r = await api(`${BASE}/api/auth`, { body: { action: 'register', phone: PHONE, password: PW1, clientId: CLIENT_ID } });
  check('① 注册（手机号+密码+设备号，无需短信码）', r.status === 200 && r.json?.ok, JSON.stringify(r.json || r).slice(0, 160));
  const uid = r.json?.user?.userId || r.json?.user?.id || null;
  const token = r.json?.token || r.json?.user?.token || null;
  check('① 注册返回 uid 与 token', Boolean(uid && token), `keys=${Object.keys(r.json || {}).join(',')}`);

  // 2. 登录 + me
  r = await api(`${BASE}/api/auth`, { body: { action: 'login', phone: PHONE, password: PW1, clientId: CLIENT_ID } });
  check('② 登录', r.status === 200 && r.json?.ok, JSON.stringify(r.json).slice(0, 120));
  const token2 = r.json?.token || token;
  r = await api(`${BASE}/api/auth/me`, { method: 'GET', token: token2 });
  check('② me（脱敏手机号）', r.status === 200 && String(r.json?.user?.phone || '').includes('****'), JSON.stringify(r.json?.user || {}).slice(0, 120));

  // 3. 年龄门（成年承诺：1999 → 27 岁）
  r = await api(`${BASE}/v1/profile/adult`, { method: 'POST', token: token2, body: { birthYear: 1999 } });
  check('③ 年龄门提交（出生年份 1999）', r.status === 200 && (r.json?.ok ?? r.json?.data?.ok), JSON.stringify(r.json).slice(0, 160));
  r = await api(`${BASE}/v1/profile/adult`, { method: 'POST', token: token2, body: { birthYear: 2015 } });
  check('③ 未成年出生年份被拒（2015 → 拒）', r.status === 400, JSON.stringify(r.json).slice(0, 120));

  // 4. 资料发布（PATCH /v1/profile/me：词表安全 + 向量重算）
  r = await api(`${BASE}/v1/profile/me`, { method: 'PATCH', token: token2, body: {
    nickname: '验收号' + PHONE.slice(-4), gender: 'female', city: '北京', job: '测试工程师',
    tags: ['电影', '徒步'], intro: '端到端验收自动生成资料，稍后注销删除。',
  } });
  check('④ 资料发布（PATCH 含向量重算）', r.status === 200 && Boolean(r.json?.data?.user || r.json?.user), JSON.stringify(r.json).slice(0, 200));
  if (uid) {
    r = await api(`${BASE}/v1/profile/${uid}`, { method: 'GET', token: token2 });
    const pub = r.json?.user || r.json?.data?.user;
    check('④ 他人视角可读资料', r.status === 200 && pub?.nickname?.startsWith('验收号'), JSON.stringify(pub || {}).slice(0, 120));
    const selfR = await api(`${BASE}/v1/profile/me`, { method: 'GET', token: token2 });
    const selfU = selfR.json?.data?.user || selfR.json?.user || {};
    check('④ 资料向量已重算（self 视角）', (selfU.profileVectorDims || 0) > 0, `dims=${selfU.profileVectorDims}`);
  }

  // 5. 客服留言（发布通道之一）
  r = await api(`${BASE}/api/contact`, { body: { message: '端到端验收留言（可删除）', clientId: CLIENT_ID, replyEmail: 'qtvq@qtvq.cn' } });
  check('⑤ 客服留言提交', r.status === 200 && (r.json?.ok ?? r.json?.data?.ok), JSON.stringify(r.json).slice(0, 160));

  // 6. 找回密码 —— 两条通道
  if (direct) {
    r = await api(`${direct}/api/auth/sms`, { body: { action: 'send', phone: PHONE } });
    check('⑥a 短信发送通道响应（阿里云侧结果如实记录）', r.status === 200 || r.status === 400 || r.status === 429, `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 140)}`);
    r = await api(`${direct}/api/auth/sms`, { body: { action: 'reset', phone: PHONE, code: '000000', newPassword: PW2 } });
    check('⑥a 短信验证码错误被拒（重置闸门有效）', r.status === 400 || r.status === 403, `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 140)}`);
  }
  r = await api(`${BASE}/api/auth`, { body: { action: 'adminResetPassword', phone: PHONE, newPassword: PW2, adminKey: ADMIN_KEY } });
  check('⑥b 客服通道重置密码（admin）', r.status === 200 && r.json?.ok, JSON.stringify(r.json).slice(0, 140));
  r = await api(`${BASE}/api/auth`, { body: { action: 'login', phone: PHONE, password: PW1, clientId: CLIENT_ID } });
  check('⑥b 旧密码已失效', r.status === 401, `HTTP ${r.status}`);
  r = await api(`${BASE}/api/auth`, { body: { action: 'login', phone: PHONE, password: PW2, clientId: CLIENT_ID } });
  check('⑥b 新密码登录成功', r.status === 200 && r.json?.ok, `HTTP ${r.status}`);
  const token3 = r.json?.token || token2;

  // 7. 跨栈会话实测：Node 签发的会话 → CF 侧解析（注销与短信都在 CF）
  if (direct) {
    r = await api(`${direct}/api/auth/delete`, { body: { password: '故意错的密码' }, token: token3 });
    check('⑦ CF 侧能解析 Node 会话（错误密码被识别而非 401 未登录）', r.status === 400, `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 140)}`);
  }

  // 8. 注销（密码确认）
  const deleteUrl = direct ? `${direct}/api/auth/delete` : `${BASE}/api/auth/delete`;
  r = await api(deleteUrl, { body: { password: PW2 }, token: token3 });
  check('⑧ 注销（密码确认）', r.status === 200 && r.json?.ok, `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  r = await api(`${BASE}/api/auth`, { body: { action: 'login', phone: PHONE, password: PW2, clientId: CLIENT_ID } });
  check('⑧ 注销后登录被拒', r.status === 401, `HTTP ${r.status}`);
  r = await api(`${BASE}/api/auth/me`, { method: 'GET', token: token3 });
  check('⑧ 注销后会话失效', r.status === 401, `HTTP ${r.status}`);

  // 9. Mongo 残留复核 + 测试痕迹清理
  const u = uid ? await db.collection('users').findOne({ _id: uid }) : null;
  check('⑨ users 已删', !u, u ? JSON.stringify({ uid: u._id }).slice(0, 80) : '');
  const profileLeft = uid ? await db.collection('users').countDocuments({ _id: uid }) : 0;
  check('⑨ 资料无残留', profileLeft === 0);
  let contactCleaned = 0;
  try { contactCleaned = (await db.collection('contact_messages').deleteMany({ clientId: CLIENT_ID })).deletedCount; }
  catch { /* 集合不存在即无痕 */ }
  console.log(`  · 测试留言清理：${contactCleaned} 条`);
  const sessions = await db.collection('sessions').countDocuments({ uid }).catch(() => 0);
  check('⑨ 会话无残留（或集合不存在）', sessions === 0, `残留 ${sessions}`);

  console.log(`\n=== 结论：通过 ${pass} · 失败 ${fail} ${failures.length ? '｜ 失败项：' + failures.join('；') : ''} ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().then(() => process.exit(0)).catch((e) => { console.error('脚本异常：', e); process.exit(1); });
