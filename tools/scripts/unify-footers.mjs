/**
 * 全站页脚统一：①补公司版权 ②邮箱标签改为「客户留言：」③清掉旧英文
 *
 * 背景（业务方 2026-09-18 反馈）：
 *   · 只有首页页脚有公司名，其余 9 个页面都没有；
 *   · 页脚邮箱前的标签是「客户邮箱」，业务方要求统一为「客户留言：」；
 *   · wheel / report 两个页面还残留旧的 Q Thought, Voice, Question 英文。
 * 页头 logo 已核对：10 个页面全部是新版，无需改动。
 */
import fs from 'node:fs';

const pages = ['index.html', 'pitfalls.html', 'profile.html', 'wheel.html', 'report.html', 'account.html', 'help.html', 'download.html', 'privacy.html', '404.html'];
const COMPANY = '我心永恒（北京）网络科技有限公司版权所有';
const COPY_LINE = `    <p class="footer-copyright">${COMPANY}</p>\n`;

let changed = 0;
const report = [];

for (const f of pages) {
  if (!fs.existsSync(f)) continue;
  let h = fs.readFileSync(f, 'utf8');
  const before = h;

  // ① 公司版权：页脚内没有就补一行（放在 footer-support 之前，保持"信息在上、链接在下"的层次）
  const footerStart = h.indexOf('<footer class="site-footer">');
  if (footerStart >= 0) {
    const footerEnd = h.indexOf('</footer>', footerStart);
    const footer = h.slice(footerStart, footerEnd);
    if (!footer.includes(COMPANY)) {
      const anchor = footer.includes('<p class="footer-support">')
        ? '<p class="footer-support">'
        : footer.includes('<p class="footer-line">')
          ? '<p class="footer-line">'
          : null;
      if (anchor) {
        // 在锚点前插入版权行
        const insertAt = h.indexOf(anchor, footerStart);
        h = `${h.slice(0, insertAt)}${COPY_LINE}${h.slice(insertAt)}`;
      }
    }
  }

  // ② 邮箱标签统一为「客户留言：」
  h = h.replace(/>客户邮箱\s*(qtvq@qtvq\.cn)</g, '>客户留言：$1<');
  h = h.replace(/>客户邮箱</g, '>客户留言：<');

  // ③ 清掉旧英文
  h = h.replace(/\s*·\s*Q Thought,\s*Voice,\s*Question/g, '');
  h = h.replace(/Q Thought,\s*Voice,\s*Question\s*·\s*/g, '');

  if (h !== before) {
    fs.writeFileSync(f, h, 'utf8');
    changed += 1;
    report.push(`✏️  ${f}`);
  } else {
    report.push(`✅ ${f}（无需改动）`);
  }
}

console.log(report.join('\n'));
console.log(`\n共修改 ${changed} 个页面\n`);

console.log('=== 改后核对 ===');
for (const f of pages) {
  if (!fs.existsSync(f)) continue;
  const h = fs.readFileSync(f, 'utf8');
  const fs2 = h.indexOf('site-footer');
  const footer = fs2 >= 0 ? h.slice(fs2, h.indexOf('</footer>', fs2)) : '';
  const company = footer.includes(COMPANY);
  const label = /客户留言：/.test(footer);
  const oldEnglish = /Q Thought, Voice, Question/.test(h);
  const oldLabel = /客户邮箱/.test(footer);
  console.log(`  ${f.padEnd(16)} 版权:${company ? '✅' : '❌'} 客户留言:${label ? '✅' : '❌'} 旧英文:${oldEnglish ? '❌残留' : '✅无'} 旧标签:${oldLabel ? '❌残留' : '✅无'}`);
}
