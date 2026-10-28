/**
 * 各端「专用端口」检查：契约单测 + 数据同源 + 线上实测
 *
 * 这个端点要同时满足三件事，任何一件坏了都是**静默**的：
 *   ① 纯函数契约正确（尤其"版本号非法时绝不强制"—— 写错会把所有用户锁在启动页）；
 *   ② 发布记录三处同源（仓库根 app-releases.json / Pages 生成副本 / 静态站 version.json）；
 *   ③ 线上真的能用（部署了、渠道判断对、能力清单没有撒谎）。
 *
 * 用法: node tools/scripts/check-app-bootstrap.mjs [--offline]
 *   --offline 只跑 ①②（不请求线上）
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const offline = process.argv.includes('--offline');
const BASE = process.env.QTVQ_API_BASE || 'https://qtvq.cn';

let fail = 0;
const bad = (m) => {
  console.log(`  ❌ ${m}`);
  fail += 1;
};
const good = (m) => console.log(`  ✅ ${m}`);

/* ───────────────── ① 契约单测（纯函数，可在任何运行时跑） ───────────────── */
console.log('=== ① 契约单测（app-release-core.js）===');
const core = await import(pathToFileURL(path.join(ROOT, 'functions', 'lib', 'app-release-core.js')).href);
const { decideUpdate, isValidVersion, compareVersions, normalizeRelease, APP_CHANNELS } = core;

const cases = [
  ['版本号非法时绝不强制', decideUpdate('abc', { version: '9.9.9', minVersion: '2.0.0', mode: 'force' }).force === false],
  ['版本号非法 → reason 指明原因', decideUpdate('abc', { version: '9.9.9', minVersion: '2.0.0', mode: 'force' }).reason === 'invalid_current_version'],
  ['低于最低版本且 mode=force → 强制', decideUpdate('1.0.0', { version: '2.0.0', minVersion: '1.5.0', mode: 'force' }).force === true],
  ['低于最低版本但 mode=prompt → 不强制', decideUpdate('1.0.0', { version: '2.0.0', minVersion: '1.5.0', mode: 'prompt' }).force === false],
  ['有新版但未低于最低 → 提示且不强制', (() => { const d = decideUpdate('1.0.0', { version: '1.2.0', minVersion: '1.0.0', mode: 'force' }); return d.needsUpdate && !d.force; })()],
  ['已是最新 → 不更新', decideUpdate('1.2.0', { version: '1.2.0', minVersion: '1.0.0', mode: 'prompt' }).needsUpdate === false],
  ['无发布记录 → no_release 且不更新', (() => { const d = decideUpdate('1.0.0', null, { hadRelease: false }); return d.reason === 'no_release' && !d.needsUpdate; })()],
  ['silent 模式仍 needsUpdate', decideUpdate('1.0.0', { version: '2.0.0', minVersion: '1.0.0', mode: 'silent' }).needsUpdate === true],
  ['1.2 == 1.2.0', compareVersions('1.2', '1.2.0') === 0],
  ['1.10 > 1.9（数值比较而非字符串）', compareVersions('1.10', '1.9') === 1],
  ['带 v 前缀不合法', isValidVersion('v1.0.0') === false],
  ['1.0.6 合法', isValidVersion('1.0.6') === true],
  ['渠道数为 14', APP_CHANNELS.length === 14],
  ['normalizeRelease 丢弃非法记录', normalizeRelease('x', { version: 'abc' }) === null],
  ['normalizeRelease 非法 mode 回落 prompt', normalizeRelease('x', { version: '2.0.0', mode: 'hack' }).mode === 'prompt'],
];
let pass = 0;
for (const [name, ok] of cases) {
  if (ok) pass += 1;
  else bad(name);
}
if (pass === cases.length) good(`${pass}/${cases.length} 全部通过`);

/* ───────────────── ② 数据同源 ───────────────── */
console.log('');
console.log('=== ② 发布记录三处同源 ===');
const srcFile = path.join(ROOT, 'app-releases.json');
let src = {};
try {
  src = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
  /*
   * 所有 `_` 开头的键都是说明块（`_说明` / `_未发布渠道`），不是渠道。
   * 原来只删 `_说明`：2026-10-28 加了第二个说明数组后，它会被当成"渠道"
   * 参与下面的逐字段比对 → 明明生成正确也报"副本与唯一源不一致"。
   * 这类"检查器自己被脏数据骗了"的问题，比被测代码错更难查，所以按前缀统一剔除。
   */
  for (const key of Object.keys(src)) {
    if (key.startsWith('_')) delete src[key];
  }
  good(`唯一源 app-releases.json 合法（已发布渠道：${Object.keys(src).join(', ') || '无'}）`);
} catch (err) {
  bad(`app-releases.json 非法：${err.message}`);
}

const genFile = path.join(ROOT, 'functions', 'data', 'app-releases.generated.js');
const genSrc = fs.existsSync(genFile) ? fs.readFileSync(genFile, 'utf8') : '';
if (!genSrc) {
  bad('缺少 functions/data/app-releases.generated.js（跑 npm run release:app-releases）');
} else {
  const gen = await import(pathToFileURL(genFile).href);
  const a = JSON.stringify(src);
  const b = JSON.stringify(gen.APP_RELEASES_GENERATED);
  if (a === b) good('Pages 生成副本与唯一源一致');
  else bad('Pages 生成副本与唯一源不一致 —— 跑 npm run release:app-releases 重新生成');
}

const manifestFile = path.join(ROOT, 'dist', 'pages-public', 'release', 'version.json');
if (!fs.existsSync(manifestFile)) {
  console.log('  ℹ️ 尚未生成 release/version.json（跑 npm run release:manifest）');
} else {
  const man = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const winSrc = src.windows?.version;
  const winMan = man.app?.windows?.version;
  if (winSrc && winMan && winSrc === winMan) good(`静态清单 windows 版本与唯一源一致（${winSrc}）`);
  else if (!winSrc && !winMan) good('静态清单与唯一源都没有 windows 版本记录（未发布）');
  else bad(`静态清单 windows=${winMan || '(空)'} 与唯一源 windows=${winSrc || '(空)'} 不一致`);
}

/* ───────────────── ③ 线上实测 ───────────────── */
if (!offline) {
  console.log('');
  console.log('=== ③ 线上实测（专用端口）===');
  const get = async (qs) => {
    const res = await fetch(`${BASE}/api/app/bootstrap${qs}`, { headers: { 'Cache-Control': 'no-cache' } });
    const text = await res.text();
    try {
      return { status: res.status, json: JSON.parse(text) };
    } catch {
      return { status: res.status, json: null, text: text.slice(0, 120) };
    }
  };

  // 不带参数 → 渠道目录
  const dir = await get('');
  if (dir.json?.channels?.length === APP_CHANNELS.length) good(`渠道目录返回 ${dir.json.channels.length} 个渠道`);
  else bad(`渠道目录异常：HTTP ${dir.status} ${dir.json ? JSON.stringify(dir.json).slice(0, 120) : dir.text}`);

  // 未知渠道 → 400 且给出可选值
  const unknown = await get('?channel=nope&version=1.0.0');
  if (unknown.status === 400 && unknown.json?.code === 'E_UNKNOWN_CHANNEL') good('未知渠道被拒并返回可选渠道列表');
  else bad(`未知渠道未被正确拒绝：HTTP ${unknown.status}`);

  // 各端真实结论
  for (const [channel, version, expect] of [
    ['wechat', '1.0.6', 'needsUpdate=false'],
    ['wechat', '0.9.0', 'needsUpdate=true'],
    ['windows', '1.0.6', 'needsUpdate=false'],
    ['windows', '1.0.0', 'needsUpdate=true'],
    ['android', '1.0.0', 'needsUpdate=false（未发布→基线）'],
  ]) {
    const r = await get(`?channel=${channel}&version=${version}`);
    const u = r.json?.update;
    if (!u) {
      bad(`${channel}@${version} 没拿到 update 结论（HTTP ${r.status}）`);
      continue;
    }
    console.log(`  ${channel}@${version}: needsUpdate=${u.needsUpdate} force=${u.force} reason=${u.reason} latest=${u.latest} downloadUrl=${u.downloadUrl || '(空)'}`);
    if (expect.startsWith('needsUpdate=false') && u.needsUpdate) bad(`${channel}@${version} 期望不更新，实际要求更新`);
    if (expect.startsWith('needsUpdate=true') && !u.needsUpdate) bad(`${channel}@${version} 期望要求更新，实际没有`);
  }

  // 能力清单：不许出现"声称可用但实际没配"的项（按当前部署的实际配置抽查）
  const caps = (await get('?channel=wechat&version=1.0.6')).json?.capabilities;
  if (!caps) {
    bad('能力清单缺失');
  } else {
    console.log(`  能力抽查：pay.wechat=${caps.pay.wechat} login.wechat=${caps.login?.wechat} voiceInput=${caps.voiceInput} llm=${caps.llm} rag=${caps.rag} report=${caps.report}`);
    if (caps.report !== true || caps.wallet !== true) bad('已上线能力（report/wallet）被报成不可用 —— 客户端会隐藏功能');
    // 非微信小程序端的支付必须为 false（各自支付未接入）
    const nonWechatPay = APP_CHANNELS.filter((c) => c !== 'wechat' && caps.pay?.[c] === true);
    if (nonWechatPay.length) bad(`非微信端被报成可支付：${nonWechatPay.join(', ')} —— 各自支付尚未接入`);
    else good('非微信小程序端的支付能力如实为 false');
  }
}

console.log('');
console.log(fail === 0 ? '✅ 专用端口检查通过' : `❌ 共 ${fail} 处问题`);
process.exit(fail ? 1 : 0);
