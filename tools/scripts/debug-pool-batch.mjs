/** 批量候选（E.94 续）：修候选三年份 + 造 12 个年龄/性别分布正确的候选 + 双视角验证 */
import process from 'node:process';
import fs from 'node:fs';
const BASE = 'https://qtvq.cn';
const { connectDB, getDB } = await import('/opt/qtvq/server/src/config/db.js');
await connectDB();
const db = getDB();
const CURRENT_YEAR = 2026;

// ① 修候选三（1995 → 2000，入池）
const fix = await db.collection('users').updateOne(
  { nickname: '测试候选三' },
  { $set: { birthYear: 2000 } },
);
console.log('候选三年份修正:', fix.modifiedCount, '(1995→2000，入 18–30 区间)');

// ② 批量造 12 个（6女6男，年龄 1996–2006 分布）
const cities = ['北京', '上海', '广州', '杭州', '成都', '深圳'];
const jobs = ['产品', '设计', '运营', '教师', '医生', '程序员'];
const tagsPool = [['电影', '徒步'], ['音乐', '健身'], ['美食', '旅行'], ['读书', '摄影'], ['游戏', '跑步'], ['咖啡', '猫']];
const created = [];
for (let i = 0; i < 12; i++) {
  const gender = i % 2 === 0 ? 'female' : 'male';
  const birthYear = 1996 + (i % 11); // 1996–2006，全部落在池区间
  const nick = `测试候选${['四','五','六','七','八','九','十','十一','十二','十三','十四','十五'][i]}`;
  const phone = '199' + String(Date.now() + i * 7).slice(-8);
  const clientId = 'seed2_' + STAMP() + '_' + i;
  const r1 = await fetch(BASE + '/api/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'register', phone, password: 'Seed#2026', clientId }),
  }).then((r) => r.json());
  const uid = r1.user?.id || r1.user?.userId;
  if (!uid) { console.log('注册失败:', phone); continue; }
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + r1.token };
  await fetch(BASE + '/v1/profile/adult', { method: 'POST', headers: H, body: JSON.stringify({ birthYear }) });
  await fetch(BASE + '/v1/profile/me', {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ nickname: nick, gender, city: cities[i % 6], job: jobs[i % 6], tags: tagsPool[i % 6], intro: `测试候选（可删）· ${birthYear} 年生` }),
  });
  created.push({ uid, phone, nickname: nick, gender, birthYear });
}
console.log('新造候选:', created.length, '个');
function STAMP() { return Date.now().toString(36).slice(-5); }

// ③ 双视角验证池子
async function poolView(viewerUid, viewerToken, label) {
  const r = await fetch(BASE + '/v1/wheel/candidates', { headers: { Authorization: 'Bearer ' + viewerToken } }).then((x) => x.json());
  const items = r?.data?.items || [];
  console.log(`${label} 视角池: ${items.length} 人 →`, items.slice(0, 6).map((c) => c.nickname).join(', '), items.length > 6 ? '…' : '');
  return items;
}
const f0 = created.find((c) => c.gender === 'female');
const m0 = created.find((c) => c.gender === 'male');
if (f0) {
  const login = await fetch(BASE + '/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'login', phone: f0.phone, password: 'Seed#2026', clientId: 'seedv_f' }) }).then((r) => r.json());
  await poolView(f0.uid, login.token, '女性候选四');
}
if (m0) {
  const login = await fetch(BASE + '/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'login', phone: m0.phone, password: 'Seed#2026', clientId: 'seedv_m' }) }).then((r) => r.json());
  await poolView(m0.uid, login.token, '男性候选五');
}

// ④ 凭据落盘（服务器 + 可拉回）
const all = JSON.parse(fs.readFileSync('/tmp/seed-candidates.json', 'utf8'));
all.batch2 = created;
fs.writeFileSync('/tmp/seed-candidates.json', JSON.stringify(all, null, 1));
console.log('凭据已更新: /tmp/seed-candidates.json（清理时全量按 stamp/前缀删）');
process.exit(0);
