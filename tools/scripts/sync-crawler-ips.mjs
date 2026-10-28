/**
 * 同步搜索引擎官方爬虫 IP 段 → nginx geo 白名单
 *
 * ## 为什么用"IP 白名单"而不是每次请求做反向 DNS
 * nginx 无法在请求路径上做 rDNS；把 DNS 查询放进每请求链路会拖慢线上，
 * 还会让上游 DNS 的抖动直接影响可用性。工业做法是**定期同步官方发布名单**：
 *   · Google 官方发布 `googlebot.json`（本项目直接拉取，最可靠）；
 *   · 百度/360/神马**没有稳定公开的机器可读列表**，只能人工核对后手工加段 ——
 *     所以脚本只自动维护 Google 段，其余段落保持人工维护（并保留注释说明原因）。
 *
 * ## 安全含义（重要）
 * 白名单是"**只有这些 IP 才允许自称爬虫**"。因此：
 *   · 宁可**少放**也不要多放：漏放导致某搜索引擎收录下降，是可发现的、可补救的；
 *     多放则等于给伪装者开门，且难发现。
 *   · 未在白名单里的"自称 Baiduspider/Googlebot"请求会被 nginx 返回 444（断连）。
 *
 * 用法：
 *   node tools/scripts/sync-crawler-ips.mjs            # 只打印将要写入的内容（dry-run）
 *   node tools/scripts/sync-crawler-ips.mjs --write    # 实际写入
 *   node tools/scripts/sync-crawler-ips.mjs --write --deploy   # 写入并上传服务器 + reload
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const GEO_FILE = path.join(ROOT, 'deploy', 'hardening', 'nginx', 'qtvq-crawlers.geo.conf');
const GOOGLE_JSON = 'https://developers.google.com/static/search/apis/ipranges/googlebot.json';

const START = '    # ---- Google (auto-generated) ----';
const END = '    # ---- end Google ----';

const args = process.argv.slice(2);
const doWrite = args.includes('--write');
const doDeploy = args.includes('--deploy');

/** 只保留 IPv4 段（nginx geo 的 IPv6 需要单独写，且名单里 v6 段很少，先不引入复杂性） */
function toV4(prefixes) {
  const out = [];
  for (const p of prefixes) {
    const v4 = p?.ipv4Prefix;
    if (v4) out.push(v4);
  }
  return out.sort();
}

async function fetchGooglePrefixes() {
  const res = await fetch(GOOGLE_JSON, { headers: { 'User-Agent': 'qtvq-ops/1.0' } });
  if (!res.ok) throw new Error(`拉取 Google IP 列表失败：HTTP ${res.status}`);
  const json = await res.json();
  const v4 = toV4(json.prefixes || []);
  if (!v4.length) throw new Error('Google IP 列表解析为空（接口结构可能变了，别急着写文件）');
  return v4;
}

function buildBlock(prefixes) {
  const lines = prefixes.map((p) => `    ${p.padEnd(18)} 1;`);
  return [START, ...lines, END].join('\n');
}

function replaceBlock(text, block) {
  const startIdx = text.indexOf(START);
  const endIdx = text.indexOf(END);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(
      `找不到 Google 段标记（${START} / ${END}）。请先在 qtvq-crawlers.geo.conf 里补上标记，避免脚本整文件覆盖掉人工维护的段落。`,
    );
  }
  return text.slice(0, startIdx) + block + text.slice(endIdx + END.length);
}

const main = async () => {
  const source = fs.readFileSync(GEO_FILE, 'utf8');
  const prefixes = await fetchGooglePrefixes();
  console.log(`Google 官方 IPv4 段：${prefixes.length} 条`);
  const next = replaceBlock(source, buildBlock(prefixes));

  const before = (source.match(/^\s*\d+\.\d+\.\d+\.\d+\/\d+/gm) || []).length;
  const after = (next.match(/^\s*\d+\.\d+\.\d+\.\d+\/\d+/gm) || []).length;
  console.log(`文件内 IPv4 段：${before} → ${after}（其余段落（百度等）由人工维护，脚本不动）`);

  if (!doWrite) {
    console.log('');
    console.log('（dry-run，未写文件。加 --write 实际写入）');
    return;
  }

  fs.writeFileSync(GEO_FILE, next, 'utf8');
  console.log(`>> 已写入 ${path.relative(ROOT, GEO_FILE)}`);

  if (doDeploy) {
    const host = process.env.QTVQ_SSH_HOST || '47.115.214.130';
    const user = process.env.QTVQ_SSH_USER || 'admin';
    const key = process.env.QTVQ_SSH_KEY || path.join(process.env.USERPROFILE || '', '.ssh', 'id_ed25519_yuan');
    console.log('>> 上传到服务器并 reload nginx');
    execFileSync('scp', ['-i', key, '-o', 'BatchMode=yes', GEO_FILE, `${user}@${host}:/tmp/qtvq-crawlers.geo.conf`], {
      stdio: 'inherit',
    });
    const remote =
      'sudo install -m 644 /tmp/qtvq-crawlers.geo.conf /etc/nginx/conf.d/qtvq-crawlers.geo.conf && ' +
      'sudo nginx -t && sudo systemctl reload nginx && echo RELOAD_OK';
    execFileSync('ssh', ['-i', key, '-o', 'BatchMode=yes', `${user}@${host}`, remote], { stdio: 'inherit' });
    console.log('>> 完成');
  } else {
    console.log('   上传：scp 到服务器后 sudo install -m 644 … /etc/nginx/conf.d/ && sudo nginx -t && sudo systemctl reload nginx');
  }
};

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
