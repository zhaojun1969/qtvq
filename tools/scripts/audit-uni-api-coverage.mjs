import fs from 'node:fs';

// 扫描 api 目录下的**全部**文件（原来写死 6 个文件名，新增模块会被漏报 —— 典型"清单过期"）
const apiDir = 'apps/qtvq-uni/src/api';
const files = fs
  .readdirSync(apiDir)
  .filter((f) => f.endsWith('.js') && f !== 'request.js' && f !== 'config.js')
  .map((f) => f.replace(/\.js$/, ''));
const paths = new Set();
for (const f of files) {
  const p = `${apiDir}/${f}.js`;
  const s = fs.readFileSync(p, 'utf8');
  for (const m of s.matchAll(/\/(?:api|v1)\/[A-Za-z0-9/_:${}.-]*/g)) {
    // 去掉模板变量与结尾斜杠，保留可比对的前缀
    paths.add(m[0].replace(/\$\{[^}]*\}/g, ':x').replace(/\/$/, '') || '/');
  }
}
const list = [...paths].sort();
console.log(`小程序调用的接口（${list.length} 个）:`);
for (const p of list) console.log('  ' + p);

const backend = [
  '/api/chat', '/api/quota', '/api/payment', '/api/payment/wechat/create', '/api/payment/wechat/query',
  '/api/auth', '/api/auth/me', '/api/auth/sms', '/api/auth/delete', '/api/auth/wechat/open',
  '/api/contact', '/api/speech', '/api/health', '/v1/report', '/v1/wheel', '/v1/wallet', '/v1/profile',
];
console.log('\n后端已提供、小程序尚未接入的接口（可作为后续补齐清单）:');
for (const b of backend) {
  if (!list.some((p) => p.startsWith(b))) console.log('  ' + b);
}
