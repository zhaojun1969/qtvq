#!/usr/bin/env node
/**
 * 微信小程序上架材料体检
 *
 * 背景：微信「深度合成-AI问答」类目、算法备案、安全评估、上传私钥、小程序码
 * 这五项**没法用代码生成**，只能人去平台申请/下载。但它们**可以自动核对**：
 * 材料放对位置没有、格式对不对、页面上有没有真展示、下载页会不会还挂着"待上传"。
 *
 * 用法：
 *   node tools/scripts/check-mp-materials.mjs            # 体检（缺项只提示，不退出非零）
 *   node tools/scripts/check-mp-materials.mjs --strict   # 上架门禁（缺任何一项即失败）
 *
 * 设计取舍：
 *   · 默认不失败，是为了不让 check-all 长期飘红 —— 长期红的检查等于没有检查；
 *   · 真正提审前用 --strict，一项不许缺；
 *   · 私钥**只读首行判断类型**，不打印内容、不计算指纹、不进日志。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const STRICT = process.argv.includes('--strict');

const ready = [];
const pending = [];
const broken = [];

const say = {
  ready: (m) => {
    ready.push(m);
    console.log(`  ✅ ${m}`);
  },
  wait: (m, how) => {
    pending.push(m);
    console.log(`  ⏳ ${m}${how ? `\n       → ${how}` : ''}`);
  },
  bad: (m) => {
    broken.push(m);
    console.log(`  ❌ ${m}`);
  },
  info: (m) => console.log(`     ${m}`),
};

const readJson = (rel) => {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    broken.push(`${rel} 不是合法 JSON：${e.message}`);
    return null;
  }
};

/** 读 PNG 尺寸（只看 IHDR，不解析整张图） */
function pngSize(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.length < 24 || b.toString('ascii', 1, 4) !== 'PNG') return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } catch {
    return null;
  }
}

console.log('[check-mp-materials] 微信小程序上架材料体检\n');

/* ── 0. 配置单一来源 ── */
const compliance = readJson('compliance.json');
const manifest = readJson('apps/qtvq-uni/src/manifest.json');
const links = readJson('release-links.json');
const appid = manifest?.['mp-weixin']?.appid || '';

console.log('微信小程序类目 / 备案 / 安全评估');
if (!compliance) {
  say.bad('compliance.json 不存在（类目/备案/评估的唯一记录处）');
} else {
  const cat = compliance.mpCategory || {};
  if (!cat.name) {
    say.wait('类目未登记', '在 compliance.json 的 mpCategory.name 填「深度合成-AI问答」等实际类目');
  } else if (!/深度合成|AI\s*问答|人工智能/i.test(cat.name)) {
    say.bad(`类目写的是「${cat.name}」—— 微信侧要求的是「深度合成-AI问答」类，请核对`);
  } else {
    say.ready(`类目：${cat.name}（状态：${cat.status || '未标注'}）`);
  }

  const algo = compliance.algorithmFiling || {};
  const ALGO_RE = /网信算备[\dA-Za-z]+号?|备案编号\s*\d{8,}/;
  if (!algo.number) {
    say.wait(
      '算法备案号未登记',
      '在 compliance.json 的 algorithmFiling.number 填备案编号，然后按下面「展示位」补到页面',
    );
  } else if (!ALGO_RE.test(algo.number)) {
    say.bad(`算法备案号格式可疑：「${algo.number}」（通常形如 网信算备XXXXXXXXXXXXX号）`);
  } else {
    say.ready(`算法备案号：${algo.number}`);
    // 备案号必须能在页面上看到，否则等于没公示
    const pages = ['privacy.html', 'terms.html'];
    const missing = pages.filter((f) => {
      const p = path.join(ROOT, f);
      return !fs.existsSync(p) || !fs.readFileSync(p, 'utf8').includes(algo.number);
    });
    if (missing.length) {
      say.bad(`备案号没在 ${missing.join('、')} 里出现 —— 算法备案要求对外公示`);
    } else {
      say.ready('备案号已在隐私说明与用户协议中展示');
    }
  }

  const sec = compliance.securityAssessment || {};
  if (!sec.reportNo && !sec.date) {
    say.wait('安全评估报告未登记', '在 compliance.json 的 securityAssessment 填报告编号与出具日期');
  } else if (sec.date && !/^\d{4}-\d{2}-\d{2}$/.test(sec.date)) {
    say.bad(`安全评估日期格式不对：${sec.date}（要 YYYY-MM-DD）`);
  } else {
    say.ready(`安全评估：${sec.reportNo || '(无编号)'} ${sec.date || ''}`.trim());
  }
}

/* ── 1. 上传私钥 ── */
console.log('\n上传私钥（用于 npm run mp:upload）');
if (!appid) {
  say.bad('manifest.json 里没有 mp-weixin.appid —— 先填 appid');
} else {
  const candidates = [path.join(ROOT, `private.${appid}.key`), path.join(ROOT, 'private.key')];
  const keyPath = candidates.find((p) => fs.existsSync(p));
  if (!keyPath) {
    say.wait(
      `私钥未就位（private.${appid}.key）`,
      `小程序后台 → 开发管理 → 开发设置 → 小程序代码上传 → 生成密钥，下载后放到 D:\\qtvq\\private.${appid}.key`,
    );
  } else {
    const buf = fs.readFileSync(keyPath, 'utf8');
    const head = buf.split(/\r?\n/)[0] || '';
    const isPem = /^-----BEGIN (RSA )?PRIVATE KEY-----/.test(head);
    if (!isPem) {
      say.bad(`${path.basename(keyPath)} 首行不是 PEM 私钥头（拿到的可能不是密钥文件）`);
    } else if (buf.length < 1000) {
      say.bad(`${path.basename(keyPath)} 只有 ${buf.length} 字节，不像完整密钥`);
    } else {
      say.ready(`私钥就位：${path.basename(keyPath)}（${buf.length} 字节，PEM 格式）`);
      say.info(`上传命令：npm run mp:upload -- --version ${manifest?.version || '1.0.x'}`);
    }
  }
}

/* ── 2. 小程序码 ── */
console.log('\n小程序码（下载页微信卡片）');
const qrcodeRel = links?.weixin?.qrcode || '';
if (!qrcodeRel) {
  say.wait(
    '未配置小程序码，下载页显示「小程序码 / 待上传」',
    '拿到码后执行：node tools/scripts/apply-mp-qrcode.mjs <图片路径>',
  );
} else {
  const abs = path.join(ROOT, qrcodeRel.replace(/^\//, ''));
  if (!fs.existsSync(abs)) {
    say.bad(`release-links.json 指向 ${qrcodeRel}，但文件不存在（下载页会显示裂图）`);
  } else {
    const size = pngSize(abs);
    if (!size) {
      say.bad(`${qrcodeRel} 不是有效 PNG（微信小程序码导出请用 PNG）`);
    } else if (size.width < 200 || size.height < 200) {
      say.bad(`${qrcodeRel} 只有 ${size.width}×${size.height}，扫码会糊（建议 ≥ 430×430）`);
    } else {
      say.ready(`小程序码就位：${qrcodeRel}（${size.width}×${size.height}）`);
    }
  }
}

/* ── 3. 页脚一致性（这项与材料无关，任何时候都要对） ── */
console.log('\n站点页脚一致性');
{
  const htmls = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
  const seen = new Map();
  for (const f of htmls) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const m = /class="footer-icp"[^>]*>([^<]*)</.exec(src);
    if (m) {
      const val = m[1].trim();
      if (!seen.has(val)) seen.set(val, []);
      seen.get(val).push(f);
    }
  }
  if (seen.size === 0) {
    say.bad('没有任何页面渲染 ICP 备案号（页脚缺失）');
  } else if (seen.size > 1) {
    say.bad(
      `页脚备案号有 ${seen.size} 种写法：` +
        [...seen.entries()].map(([v, fs2]) => `「${v}」×${fs2.length}`).join('、'),
    );
  } else {
    const [val, files] = [...seen.entries()][0];
    say.ready(`页脚备案号 ${files.length} 个页面一致：${val}`);
  }
}

/* ── 汇总 ── */
console.log(
  `\n[check-mp-materials] 就绪 ${ready.length} · 待补 ${pending.length} · 问题 ${broken.length}`,
);
if (pending.length) {
  console.log('\n待补清单（材料到位后重跑本命令）：');
  for (const p of pending) console.log(`  · ${p}`);
}
if (broken.length) {
  console.log('\n必须处理：');
  for (const b of broken) console.log(`  · ${b}`);
}

const failed = broken.length > 0 || (STRICT && pending.length > 0);
if (failed) {
  console.log(
    STRICT
      ? '\n❌ 未达到上架条件（--strict）'
      : '\n❌ 存在不一致项，需处理',
  );
  process.exit(1);
}
console.log(pending.length ? '\n⏳ 代码侧无问题，等外部材料。' : '\n✅ 材料齐备。');
