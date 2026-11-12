/** 候选池种子（E.94）：造 3 个完整测试候选（明确命名），验证互相可见；凭据输出供清理 */
import process from 'node:process';
import fs from 'node:fs';
const BASE = 'https://qtvq.cn';
const { connectDB, getDB } = await import('/opt/qtvq/server/src/config/db.js');
await connectDB();
const db = getDB();

const STAMP = Date.now().toString(36).slice(-5);
const SEEDS = [
  { nick: '测试候选一', gender: 'female', birthYear: 1998, city: '北京', job: '设计师', tags: ['电影', '徒步'], intro: '测试候选账号一（可删）。' },
  { nick: '测试候选二', gender: 'male', birthYear: 1996, city: '北京', job: '工程师', tags: ['音乐', '健身'], intro: '测试候选账号二（可删）。' },
  { nick: '测试候选三', gender: 'female', birthYear: 1995, city: '上海', job: '运营', tags: ['美食', '旅行'], intro: '测试候选账号三（可删）。' },
];
const created = [];
for (const cfg of SEEDS) {
  const phone = '199' + String(Date.now() + created.length).slice(-8);
  const clientId = 'seed_' + STAMP + '_' + created.length;
  const r1 = await fetch(BASE + '/api/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'register', phone, password: 'Seed#2026', clientId }),
  }).then((r) => r.json());
  const uid = r1.user?.id || r1.user?.userId;
  const token = r1.token;
  if (!uid) { console.log('注册失败:', phone, JSON.stringify(r1).slice(0, 80)); continue; }
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  await fetch(BASE + '/v1/profile/adult', { method: 'POST', headers: H, body: JSON.stringify({ birthYear: cfg.birthYear }) });
  await fetch(BASE + '/v1/profile/me', {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ nickname: cfg.nick, gender: cfg.gender, city: cfg.city, job: cfg.job, tags: cfg.tags, intro: cfg.intro }),
  });
  created.push({ uid, phone, nickname: cfg.nick, token });
  console.log('已建:', cfg.nick, uid, '短号段:', phone.slice(-4));
}

// 验证：以第一个候选的视角看池子（其余两个应出现）
if (created.length >= 2) {
  const H = { Authorization: 'Bearer ' + created[0].token };
  const r = await fetch(BASE + '/v1/wheel/candidates', { headers: H }).then((x) => x.json());
  const cand = r?.data?.candidates || r?.candidates || [];
  const names = cand.map((c) => c.nickname);
  console.log('候选池（候选一视角）:', cand.length, '人 →', names.join(', ') || '(空)');
  console.log(names.includes('测试候选二') && names.includes('测试候选三') ? '✅ 种子候选互相可见' : '❌ 池子里看不到种子候选');
}

// 凭据留档（清理与登录用）
fs.writeFileSync('/tmp/seed-candidates.json', JSON.stringify({ stamp: STAMP, created }, null, 1));
console.log('凭据: /tmp/seed-candidates.json（清理时按 stamp 删）');
process.exit(0);
