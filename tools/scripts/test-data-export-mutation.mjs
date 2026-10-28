#!/usr/bin/env node
/**
 * 变异测试：验证 check-data-export.mjs 的断言**真的会红**
 *
 * 为什么需要这一层
 * --------------
 * 上一轮（check-review-compliance）首轮 9 条变异里活了 2 条，都是同一个病：
 * 断言测的是"文件里出现过某个字符串"，不是"这个行为真的存在"。
 * 这次直接对 shaper 做行为断言，但仍要用变异证明 —— 否则"47 项全过"
 * 可能只是 47 条永远不会红的装饰。
 *
 * 两条纪律（上一轮踩过）：
 *   · 跳过 ≠ 存活：片段对不上说明检查器与实现已漂移（变异没真正执行），
 *     要和"变异了但没被发现"分开计数，否则会让人去改本来写对的检查器。
 *   · 按文件实际换行符匹配：仓库是 CRLF，脚本里写 LF 的多行片段 includes() 永远 false。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CHECKER = path.join(ROOT, 'tools/scripts/check-data-export.mjs');

function readUtf8(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 把片段里的 \n 换成文件实际的换行符，避免 CRLF 导致的假"跳过" */
function adapt(original, snippet) {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  return snippet.replace(/\n/g, eol);
}

const MUTATIONS = [
  {
    name: '导出路由去掉 requireAuth',
    file: 'server/src/routes/data-export.js',
    from: "  '/export',\n  requireAuth,",
    to: "  '/export',",
  },
  {
    name: '订单导出带上 trace（设备/IP/手机号）',
    file: 'server/src/routes/data-export.js',
    from: '    channel: o.channel || null,',
    to: '    channel: o.channel || null,\n    trace: o.trace || null,',
  },
  {
    name: '账号导出带上 128 维向量',
    file: 'server/src/routes/data-export.js',
    from: '    status: doc.status || null,',
    to: '    status: doc.status || null,\n    profileVector: doc.profileVector || null,',
  },
  {
    name: '能力清单改回 dataExport: false',
    file: 'server/src/lib/app-release.js',
    from: 'dataExport: true',
    to: 'dataExport: false',
  },
  {
    name: '官网导出把 token 拼进 URL',
    file: 'js/account.js',
    from: "const res = await apiFetch('/v1/me/export');",
    to: "location.href = `/v1/me/export?token=${localStorage.getItem('qtvq_auth_token')}`;",
  },
  {
    name: '明确级命中时仍下发第二档（两张叠一起）',
    file: 'server/src/routes/chat.js',
    from: 'const gentleTip = supportCard ? null : buildGentleTip(distressCheck(message.trim()));',
    to: 'const gentleTip = buildGentleTip(distressCheck(message.trim()));',
  },
  {
    name: 'H5 去掉"一次会话只出现一次"的门',
    file: 'js/home.js',
    from: "    if (sessionStorage.getItem(GENTLE_SHOWN_KEY) === '1') return false;",
    to: '',
  },
  {
    name: '第二档文件里硬编码号码',
    file: 'packages/safety/src/distress.js',
    from: "    text: '听起来有很难熬的时刻。如果愿意，可以找个人说说话 —— 不用一个人扛。',",
    to: "    text: '撑不下去可以打 12356。',",
  },
  {
    name: '小程序窄条改成每条消息都渲染',
    file: 'apps/qtvq-uni/src/pages/index/index.vue',
    from: '<view v-if="m.gentle && i === gentleAt" class="gentle-tip">',
    to: '<view v-if="m.gentle" class="gentle-tip">',
  },
  {
    name: '第二档收窄过头（漏掉「撑不下去」）',
    file: 'packages/safety/src/distress.js',
    from: 're: /(撑不下去|撑不住|扛不住|顶不住|熬不住|坚持不下去|受不了了(?![他她它你这那]))/,',
    to: 're: /(坚持不下去)/,',
  },
];

let survived = 0;
let skipped = 0;
let killed = 0;

for (const m of MUTATIONS) {
  const abs = path.join(ROOT, m.file);
  const original = fs.readFileSync(abs, 'utf8');
  const from = adapt(original, m.from);
  const to = adapt(original, m.to);
  if (!original.includes(from)) {
    console.log(`⚠️  跳过（片段已不存在，检查器与实现已漂移）：${m.name}`);
    skipped += 1;
    continue;
  }
  fs.writeFileSync(abs, original.replace(from, to), 'utf8');
  let red = false;
  try {
    execFileSync(process.execPath, [CHECKER], { cwd: ROOT, stdio: 'pipe' });
  } catch {
    red = true;
  } finally {
    fs.writeFileSync(abs, original, 'utf8');
  }
  if (red) {
    console.log(`✅ 判红：${m.name}`);
    killed += 1;
  } else {
    console.log(`❌ 存活（假断言）：${m.name}`);
    survived += 1;
  }
}

console.log('');
console.log(`判红 ${killed} / 存活 ${survived} / 跳过 ${skipped}（共 ${MUTATIONS.length}）`);
if (survived) {
  console.log('❌ 存在未被发现的变异，检查器有假断言');
  process.exit(1);
}
if (skipped) {
  console.log('⚠️  有变异因片段漂移被跳过：这不算通过，请更新变异片段');
  process.exit(1);
}
console.log('✅ 全部变异判红，断言有效');
