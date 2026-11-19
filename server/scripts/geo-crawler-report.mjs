/** G4 AI/引擎爬虫到访周报（E.111 Node 版，随 deploy-server-ssh 部署）
 *
 * 读取 nginx access.log（当前+轮转），按 13 类 AI/搜索引擎爬虫统计到访次数、
 * 状态码分布与热门路径——GEO「抓取→引用」转化的观测数据源。
 *
 * 跑法（服务器，root crontab 每周一 09:30）：
 *   cd /opt/qtvq/server && node scripts/geo-crawler-report.mjs
 * 输出追加到 /var/log/qtvq-geo-weekly.log（由 cron 重定向）。
 */
import fs from 'node:fs';

const LOGS = ['/var/log/nginx/access.log', '/var/log/nginx/access.log.1'];
const PATTERNS = {
  GPTBot: 'GPTBot',
  'OAI-SearchBot': 'OAI-SearchBot',
  'ChatGPT-User': 'ChatGPT-User',
  ClaudeBot: 'ClaudeBot',
  PerplexityBot: 'PerplexityBot',
  'Google-Extended': 'Google-Extended',
  Applebot: 'Applebot',
  Bytespider: 'Bytespider',
  Baiduspider: 'Baiduspider',
  bingbot: 'bingbot',
  Googlebot: 'Googlebot',
  '360Spider': '360Spider',
  Yisou: 'YisouSpider',
};

const counts = new Map();
const statuses = new Map();
const paths = new Map();
let total = 0;

for (const logf of LOGS) {
  let text = '';
  try {
    text = fs.readFileSync(logf, 'utf8');
  } catch {
    continue;
  }
  for (const line of text.split('\n')) {
    for (const [name, pat] of Object.entries(PATTERNS)) {
      if (!line.includes(pat)) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
      if (!statuses.has(name)) statuses.set(name, new Map());
      const sm = line.match(/" (\d{3}) /);
      const st = sm ? sm[1] : '?';
      statuses.get(name).set(st, (statuses.get(name).get(st) || 0) + 1);
      if (!paths.has(name)) paths.set(name, new Map());
      const pm = line.match(/"[A-Z]+ (\S+)/);
      if (pm) paths.get(name).set(pm[1], (paths.get(name).get(pm[1]) || 0) + 1);
      total += 1;
    }
  }
}

console.log('== AI/引擎爬虫到访周报 ==');
for (const [name, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  const st = JSON.stringify([...statuses.get(name).entries()]);
  const top3 = [...(paths.get(name) || new Map()).entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([p, c]) => `${p}(${c})`)
    .join('; ');
  console.log(`  ${name}: ${n} 次 | 状态 ${st} | 热门: ${top3}`);
}
console.log(`  合计: ${total} 次`);
if (total === 0) {
  console.log('  ⚠️ 本周零 AI 爬虫到访——核查 robots.txt / llms.txt 可达性与站长平台提交状态');
}
