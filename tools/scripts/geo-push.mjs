/** G2 主动推送：IndexNow（Bing/Seznam/Yandex）+ 百度推送（token 就绪后启用）+ sitemap 位置报告 */
import process from 'node:process';
import fs from 'node:fs';
const BASE = 'https://qtvq.cn';

// IndexNow key 从仓库 key 文件读取（已上线）
const keyFile = fs.readdirSync('.').find((f) => /^[0-9a-f-]{36}\.txt$/.test(f));
if (!keyFile) { console.error('IndexNow key 文件缺失'); process.exit(1); }
const key = fs.readFileSync(keyFile, 'utf8').trim();

const pages = [
  '/', '/pitfalls.html', '/advice.html', '/wheel.html', '/report.html',
  '/profile.html', '/help.html', '/download.html', '/privacy.html', '/terms.html',
  '/land.html',
];
const host = 'qtvq.cn';
const urlList = pages.map((p) => `https://${host}${p}`);

// IndexNow：POST URL 批量到 api.indexnow.org（Bing/Yandex/Seznam 共享协议）
const idxRes = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({
    host,
    key,
    keyLocation: `${BASE}/${keyFile}`,
    urlList,
  }),
  signal: AbortSignal.timeout(10000),
});
console.log('IndexNow:', idxRes.status, idxRes.status === 200 || idxRes.status === 202 ? '✓ 推送成功' : '（检查 key/域名配置）');

// 百度主动推送：token 从 BAIDU_SITE_TOKEN 环境变量读（业务方在百度站长平台获取后注入）
const bdToken = process.env.BAIDU_SITE_TOKEN;
if (bdToken) {
  const bdRes = await fetch(`http://data.zz.baidu.com/urls?site=${host}&token=${bdToken}`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: urlList.join('\n'),
    signal: AbortSignal.timeout(10000),
  }).catch((e) => ({ status: 0, body: e.message }));
  console.log('百度推送:', bdRes.status, String(bdRes.body || '').slice(0, 120));
} else {
  console.log('百度推送: BAIDU_SITE_TOKEN 未配置——业务方在百度站长平台验证后获取，注入 env 后重跑本脚本');
}

console.log('提交 URL 数:', urlList.length);
process.exit(0);
