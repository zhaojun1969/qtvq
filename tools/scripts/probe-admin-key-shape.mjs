/**
 * 验证假设：服务器 .env 里的 ADMIN_KEY 是不是被尖括号/引号包住了。
 * dotenv 只剥引号、**不剥尖括号** —— 若写成 ADMIN_KEY=<xxx>，解析出来的值就带 < >，
 * 于是任何"只输 xxx"的人都会一直 401（这种错极难自查，因为肉眼看值是对的）。
 * 只打印变体描述与结果，不打印密钥内容。
 */
import fs from 'node:fs';

const env = fs.readFileSync('server/.env', 'utf8');
const line = env.split(/\r?\n/).find((l) => l.startsWith('ADMIN_KEY='));
const base = line.slice('ADMIN_KEY='.length).trim();

const variants = [
  ['纯净值（不带任何符号）', base],
  ['尖括号包裹 <v>', `<${base}>`,
  ],
  ['全角尖括号包裹 ＜v＞', `＜${base}＞`],
  ['双引号包裹 "v"', `"${base}"`],
  ['单引号包裹 \'v\'', `'${base}'`],
  ['中文方括号【v】', `【${base}】`],
  ['前导空格', ` ${base}`],
];

console.log(`基准值：尾部 ${base.slice(-4)}，长度 ${base.length}（不打印内容）`);
console.log('');
console.log('=== 逐个变体试 /v1/admin/overview（200 = 服务器上存的就是这个形态）===');
for (const [label, value] of variants) {
  try {
    const res = await fetch('https://qtvq.cn/v1/admin/overview', { headers: { 'X-Admin-Key': value } });
    const mark = res.status === 200 ? '  ★★★ 命中！服务器上的值就是这种形态' : '';
    console.log(`  ${String(res.status).padEnd(4)} ${label}${mark}`);
  } catch (e) {
    console.log(`  ERR  ${label} ${e.message}`);
  }
}
