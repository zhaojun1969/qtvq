import fs from 'node:fs';

const w = fs.readFileSync('server/src/services/wheel.js', 'utf8');
const i = w.indexOf('export async function spin');
console.log('=== /v1/wheel/spin 返回结构（关键字段）===');
const body = w.slice(i, i + 2600);
for (const line of body.split(/\r?\n/)) {
  if (/(uid|nickname|gender|city|tags|avatar|targetIndex|billing|charged|balance|label|return \{|spinId|createdAt)/.test(line)) {
    console.log('  ' + line.trim().slice(0, 120));
  }
}

console.log('\n=== PATCH /v1/profile/me 接收字段 ===');
const p = fs.readFileSync('server/src/routes/profile.js', 'utf8');
const j = p.indexOf('router.patch');
const seg = p.slice(j, j + 1600);
for (const line of seg.split(/\r?\n/)) {
  if (/(req\.body|nickname|gender|city|tags|intro|birth|const \{|ALLOWED|pick)/.test(line)) {
    console.log('  ' + line.trim().slice(0, 130));
  }
}

console.log('\n=== 资料相关的模型字段（db 查询里的投影）===');
const s = fs.readFileSync('server/src/services/wheel.js', 'utf8');
const proj = /const CANDIDATE_PROJECTION = \{[\s\S]*?\};/.exec(s);
console.log(proj ? proj[0].replace(/\n/g, '\n  ') : '(未找到)');
