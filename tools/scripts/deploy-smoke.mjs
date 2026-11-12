/**
 * 部署后冒烟（E.88）：GET + POST 双面探针，专防「/v1/health 绿但某条 POST 路由崩」的事故重演。
 *
 * 事故背景（E.86）：contact.js 引用顺序错误导致进程在**首个 POST /api/contact** 时崩溃
 * 循环 + 502，而部署自检只打 /v1/health —— GET 绿、POST 全死的窗口期完全无声。
 *
 * 判定口径（匿名探针，不产生任何数据）：
 *   · 期望状态码按各端点契约（401/400/404/200 都是"活着"）；
 *   · 502/503/526 或响应体是 HTML（nginx 错误页/崩循环）＝ 部署失败；
 *   · Content-Type 必须是 JSON（应用层响应），HTML 一律判死。
 *
 * 用法：
 *   node tools/scripts/deploy-smoke.mjs                # 默认打 https://qtvq.cn
 *   node tools/scripts/deploy-smoke.mjs --base http://127.0.0.1:3000   # 服务器本地自检
 */
import process from 'node:process';

const BASE = (() => {
  const i = process.argv.indexOf('--base');
  return i > 0 ? process.argv[i + 1] : 'https://qtvq.cn';
})();

let fail = 0;
const probes = [
  // GET：健康面
  { m: 'GET', p: '/v1/health', expect: 200 },
  { m: 'GET', p: '/api/health', expect: 200 },
  { m: 'GET', p: '/api/auth/me', expect: 401 },
  { m: 'GET', p: '/v1/wallet', expect: 401 },
  // POST：E.86 事故类探针（全部匿名无副作用，错误入参走校验分支）
  { m: 'POST', p: '/api/contact', body: {}, expect: 400 },            // 空留言 → 校验 400
  { m: 'POST', p: '/api/auth', body: { action: 'login' }, expect: 400 }, // 缺参数 → 400
  { m: 'POST', p: '/v1/moderation/report', body: {}, expect: 401 },   // 未登录 → 401
  { m: 'POST', p: '/v1/contact/reveal', body: {}, expect: 401 },      // 未登录 → 401
  { m: 'POST', p: '/v1/track', body: { events: [] }, expect: 200 },  // 空批次优雅处理（契约：accepted:0）
];

for (const { m, p, expect } of probes) {
  let status = 0, ct = '', isHtml = false;
  try {
    const res = await fetch(BASE + p, {
      method: m,
      headers: { 'Content-Type': 'application/json' },
      body: m === 'POST' ? JSON.stringify(probes.find((x) => x.p === p).body ?? {}) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    status = res.status;
    ct = res.headers.get('content-type') || '';
    const text = await res.text();
    isHtml = /^\s*<(!doctype|html)/i.test(text);
    var preview = text.slice(0, 80).replace(/\n/g, ' ');
  } catch (e) {
    fail += 1;
    console.log(`  ❌ ${m} ${p} → 网络异常 ${String(e.message).slice(0, 60)}`);
    continue;
  }
  const alive = status !== 0 && ![502, 503, 504, 526].includes(status) && !isHtml && ct.includes('json');
  if (!alive) {
    fail += 1;
    console.log(`  ❌ ${m} ${p} → HTTP ${status} ${isHtml ? 'HTML 错误页（疑似崩循环/网关故障）' : ''} ${preview || ''}`);
  } else if (status !== expect) {
    fail += 1;
    console.log(`  ❌ ${m} ${p} → HTTP ${status}（期望 ${expect}）${preview ? ' ' + preview : ''}`);
  } else {
    console.log(`  ✅ ${m} ${p} → ${status}`);
  }
}

console.log(fail === 0 ? `\n✅ 冒烟全过：GET/POST 双面活着，无 5xx/HTML 错误页` : `\n❌ 冒烟失败 ${fail} 项 —— 部署疑似有问题，禁止放行`);
process.exit(fail === 0 ? 0 : 1);
