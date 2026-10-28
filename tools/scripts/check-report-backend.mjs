import fs from 'node:fs';

const env = fs.readFileSync('server/.env', 'utf8');
const key = env
  .split(/\r?\n/)
  .find((l) => l.startsWith('ADMIN_KEY='))
  .slice('ADMIN_KEY='.length)
  .trim();

const endpoints = ['/v1/admin/overview', '/v1/admin/health', '/v1/health', '/v1/admin/moderation-stats'];

for (const p of endpoints) {
  try {
    const res = await fetch(`https://qtvq.cn${p}`, { headers: { 'X-Admin-Key': key } });
    const text = await res.text();
    console.log(`=== ${p}  HTTP ${res.status} ===`);
    try {
      console.log(JSON.stringify(JSON.parse(text), null, 2).slice(0, 1400));
    } catch {
      console.log(text.slice(0, 400));
    }
    console.log('');
  } catch (e) {
    console.log(`=== ${p} ERR ${e.message} ===\n`);
  }
}
