/**
 * 统一所有页面的 logo 文案（10 个 HTML 各写了一份，必须一起改，否则每个页头说的话都不一样）。
 *
 * 目标形态：
 *   <div class="logo-text">Q问<span>问出爱情真谛</span></div>
 *
 * 处理两种现有写法：
 *   A. 单行：<div class="logo-text">我心永恒<span>Q问 · qtvq.cn</span></div>
 *   B. 多行：换行 + 缩进的等价写法（含 index.html 已改成"Q问 · qtvq.cn / 问出爱情真谛"的那份）
 *
 * 只替换 logo-text 这一个 div 的内容，不碰其它任何标记；改完逐个校验并报告。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 目标形态（v2）：
 *   <div class="logo-text"><span class="logo-title">Q问</span><span class="logo-sub">问出爱情真谛</span></div>
 *
 * 为什么要把标题拆成独立 span：要在「Q问」两字之间留一个字宽，就得给它加 letter-spacing，
 * 而 letter-spacing 会在**末字之后也补一份**间距 —— 必须在这**一个元素自己身上**用负 margin 抵消，
 * 居中才正确。v1 把补偿加在 `.logo-text` 外层，结果把标题和副标题整块推偏了 1em（业务方一眼看出没居中）。
 */
const NEW_INNER =
  '<span class="logo-title">Q问</span><span class="logo-sub">问出爱情真谛</span>';
const files = [
  'index.html',
  'account.html',
  'report.html',
  'wheel.html',
  'profile.html',
  'pitfalls.html',
  'help.html',
  'download.html',
  'privacy.html',
  '404.html',
];

const re = /<div class="logo-text">[\s\S]*?<\/div>/;
let changed = 0;
const report = [];

for (const f of files) {
  if (!fs.existsSync(f)) {
    report.push(`⏭  ${f}: 不存在`);
    continue;
  }
  const before = fs.readFileSync(f, 'utf8');
  const m = re.exec(before);
  if (!m) {
    report.push(`❌ ${f}: 找不到 logo-text 区块`);
    continue;
  }
  const replacement = `<div class="logo-text">${NEW_INNER}</div>`;
  if (m[0] === replacement) {
    report.push(`✅ ${f}: 已是目标形态`);
    continue;
  }
  const after = before.replace(re, replacement);
  fs.writeFileSync(f, after, 'utf8');
  changed += 1;
  report.push(`✏️  ${f}: 已更新`);
}

console.log(report.join('\n'));
console.log(`\n共修改 ${changed} 个文件`);

// 反向校验：所有页面都不应再出现旧文案
console.log('\n=== 反向校验（不应再出现旧字符串）===');
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  const t = fs.readFileSync(f, 'utf8');
  const bad = [];
  if (t.includes('Q问 · qtvq.cn')) bad.push('Q问 · qtvq.cn');
  if (/<div class="logo-text">\s*我心永恒/.test(t)) bad.push('我心永恒（logo 主标题）');
  console.log(`  ${f.padEnd(16)} ${bad.length ? `❌ 仍含 ${bad.join(' / ')}` : '干净 ✅'}`);
}
