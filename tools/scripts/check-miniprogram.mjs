/**
 * 小程序端静态检查：把"打包能过、一点就报错"这类问题挡在本地。
 *
 * 起因：2026-09-17 给订阅页加 channelTip 时，用了函数却没改 import ——
 * 这种漏引入 bundler 不会报，要到用户点开收款码时才 ReferenceError。
 * 这里对 uni-app 源码做两项检查：
 *   1) 从 pay-channels.js 导出的名字，在 .vue 里被用到时必须已 import；
 *   2) 支付渠道 id 必须与 Web 端 js/pay-qr.js 保持一致（两端渠道写死在不同文件里，最容易漂移）。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const UNI = path.join(ROOT, 'apps', 'qtvq-uni', 'src');
let fail = 0;
const bad = (msg) => {
  console.log(`❌ ${msg}`);
  fail += 1;
};
const ok = (msg) => console.log(`✅ ${msg}`);

/* 1) pay-channels.js 的导出是否都被正确 import */
const channelsFile = path.join(UNI, 'data', 'pay-channels.js');
const channelsSrc = fs.readFileSync(channelsFile, 'utf8');
const exported = [...channelsSrc.matchAll(/export (?:const|function) (\w+)/g)].map((m) => m[1]);
console.log(`pay-channels.js 导出：${exported.join(', ')}`);

const vueFiles = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.vue')) vueFiles.push(p);
  }
};
walk(UNI);

for (const file of vueFiles) {
  const src = fs.readFileSync(file, 'utf8');
  const importLine = /import \{([^}]+)\} from '[^']*pay-channels\.js'/.exec(src);
  const imported = importLine ? importLine[1].split(',').map((s) => s.trim()) : [];
  for (const name of exported) {
    const used = new RegExp(`\\b${name}\\b`).test(src.replace(importLine ? importLine[0] : '', ''));
    if (used && !imported.includes(name)) {
      bad(`${path.relative(ROOT, file)} 使用了 ${name}，但没有从 pay-channels.js 引入（打包能过，运行时 ReferenceError）`);
    }
  }
}
if (fail === 0) ok('pay-channels.js 的导出在 .vue 中均已正确引入');

/* 2) 渠道 id 两端一致性 —— 判据改为「对着**唯一来源**校验」
 *
 * 2026-10-11 调整：`js/pay-qr.js` 不再自己写一份渠道表，而是
 * `export { STATIC_PAY_CHANNELS as PAY_CHANNELS, channelTip } from '../packages/shared/src/index.js'`。
 * 于是旧写法（正则去 js/pay-qr.js 里抠 `export const PAY_CHANNELS`）必然抠不到，
 * 会报"Web= 空"的假阳性 —— 那是**检查器自身**过时了，不是两端真的不一致。
 *
 * 新判据分两层，比原来更强：
 *   ① 网页端**必须**从 shared 再导出（否则就是又抄了一份，将来必然漂移）；
 *   ② 小程序端的 id 必须与 shared 里的完全一致。
 */
const sharedPath = path.join(ROOT, 'packages', 'shared', 'src', 'index.js');
const sharedSrc = fs.readFileSync(sharedPath, 'utf8');
const webSrc = fs.readFileSync(path.join(ROOT, 'js', 'pay-qr.js'), 'utf8');

const sharedStart = sharedSrc.indexOf('export const STATIC_PAY_CHANNELS');
const sharedEnd = sharedSrc.indexOf('\n};', sharedStart);
const sharedObj = sharedStart >= 0 ? sharedSrc.slice(sharedStart, sharedEnd > 0 ? sharedEnd : undefined) : '';
const webIds = [...sharedObj.matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
/*
 * 2026-10-11：小程序端 `data/pay-channels.js` 已改为从 `@qtvq/shared` 派生（不再写死字面量）。
 * 旧正则抠不到 `id: '…'` 会得到空数组，进而报"小程序= 空"的**假阳性** —— 那是检查器过时，
 * 不是两端真的不一致。派生时其渠道集合就等于唯一来源本身。
 */
const uniDerivesFromShared = /@qtvq\/shared|packages\/shared\/src\/index\.js/.test(channelsSrc);
const uniIds = uniDerivesFromShared ? webIds : [...channelsSrc.matchAll(/id: '([^']+)'/g)].map((m) => m[1]);

const webReExports = /from\s+'[^']*packages\/shared\/src\/index\.js'/.test(webSrc);
if (webIds.length === 0) {
  bad('未能从 packages/shared/src/index.js 解析出渠道 id（检查器自身的问题，不要据此判断两端不一致）');
} else if (!webReExports) {
  bad('js/pay-qr.js 没有从 packages/shared 再导出渠道表 —— 又抄了一份，将来必然两端漂移');
} else if (webIds.length === uniIds.length && webIds.every((id) => uniIds.includes(id))) {
  ok(`渠道一致（唯一来源 shared 与小程序都是：${uniIds.join('、')}；网页端确认来自 shared）`);
} else {
  bad(`渠道不一致：shared=${webIds.join('、')} / 小程序=${uniIds.join('、')}`);
}

/* 3) 静态收款码图片是否真实存在（渠道写对了但图缺失同样点开就白屏） */
for (const m of channelsSrc.matchAll(/id: '([^']+)'[\s\S]{0,240}?image: '([^']+)'/g)) {
  const [, id, img] = m;
  const rel = img.replace(/^\//, ''); // '/static/payment/x.png' → 'static/payment/x.png'
  const abs = path.join(UNI, rel); // uni-app 的 /static 映射到 src/static
  if (fs.existsSync(abs)) ok(`渠道 ${id} 图片存在：${img}`);
  else bad(`渠道 ${id} 的图片不存在：${img}（期望路径 ${path.relative(ROOT, abs)}）`);
}

/* 4) 举报原因白名单三处一致性（服务端 / Web / 小程序）
 *
 * 2026-09-18 发现的死胡同：小程序举报页把自由文本直接当 reason 提交，
 * 而服务端 REPORT_REASONS 是白名单 —— 每次提交都 400 E_BAD_REASON「无效的举报原因」，
 * 用户看到的就是"举报永远失败"。三处名单写死在三个文件里，必须机器守住。 */
/*
 * 唯一来源（packages/shared）里的举报原因 —— 供"已派生"的文件比对。
 * 为什么要有它：小程序 `api/moderation.js` 现在从 shared 导入 REPORT_REASONS，
 * 文件里没有字面量数组；旧的"抠字面量"逻辑会返回 null，报"未能解析出举报原因名单：
 * 小程序（检查器自身的问题）"。派生即等价，不该判成失败。
 */
const sharedReasonList = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'packages', 'shared', 'src', 'index.js'), 'utf8');
  const m = /REPORT_REASONS\s*=\s*\[([^\]]+)\]/.exec(src);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null;
})();
const readList = (file, re) => {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  /*
   * 加严（2026-10-11）：举报原因的每一处来源**都必须派生自 packages/shared**。
   * 以前是"三处各写一份 + 比对是否相等"——那只能**发现**漂移；现在只要有人再写一份字面量，
   * 这里立刻判红，从"发现"变成"不允许"。
   */
  if (!/@qtvq\/shared|packages\/shared\/src\/index\.js/.test(src)) {
    bad(`${file} 未从 packages/shared 派生举报原因 —— 又抄了一份，将来必然两端漂移`);
    return null;
  }
  // 已改为从 shared 派生的文件：其名单等于唯一来源（见上）
  if (/@qtvq\/shared|packages\/shared\/src\/index\.js/.test(src)) return sharedReasonList;
  const m = re.exec(src);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null;
};
const lists = {
  服务端: readList('server/src/services/moderation.js', /REPORT_REASONS\s*=\s*\[([^\]]*)\]/),
  Web: readList('js/report-api.js', /REPORT_REASONS\s*=\s*\[([^\]]*)\]/),
  小程序: readList('apps/qtvq-uni/src/api/moderation.js', /REPORT_REASONS\s*=\s*\[([^\]]*)\]/),
};
const missing = Object.entries(lists).filter(([, v]) => !v);
if (missing.length) {
  bad(`未能解析出举报原因名单：${missing.map(([k]) => k).join('、')}（检查器自身的问题，不要据此判断不一致）`);
} else {
  const [first, ...rest] = Object.values(lists);
  const same = rest.every((v) => v.length === first.length && v.every((x) => first.includes(x)));
  if (same) ok(`举报原因名单三处一致（${first.join('、')}）`);
  else bad(`举报原因名单不一致：${Object.entries(lists).map(([k, v]) => `${k}=${v.join('/')}`).join(' ; ')}`);
}

console.log('');
console.log(fail === 0 ? '=== 小程序静态检查全部通过 ===' : `=== 小程序静态检查发现 ${fail} 个问题 ===`);
process.exit(fail ? 1 : 0);
