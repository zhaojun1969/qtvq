import fs from 'node:fs';

const pages = ['index.html', 'pitfalls.html', 'profile.html', 'wheel.html', 'report.html', 'account.html', 'help.html', 'download.html', 'privacy.html', '404.html'];
const LINK = '<a href="mailto:qtvq@qtvq.cn" class="footer-link-btn" data-open-contact>qtvq@qtvq.cn</a>';
const LINK_LABELED = '<a href="mailto:qtvq@qtvq.cn" class="footer-link-btn" data-open-contact>客户留言：qtvq@qtvq.cn</a>';

let changed = 0;
for (const f of pages) {
  if (!fs.existsSync(f)) continue;
  let h = fs.readFileSync(f, 'utf8');
  const before = h;

  // ① 未加标签的邮箱链接 → 加上「客户留言：」
  h = h.split(LINK).join(LINK_LABELED);

  // ② 页脚里完全没有邮箱的（如账户页）→ 在 footer-support 里补一行
  const fs2 = h.indexOf('<footer class="site-footer">');
  if (fs2 >= 0) {
    const fe = h.indexOf('</footer>', fs2);
    const footer = h.slice(fs2, fe);
    if (!/qtvq@qtvq\.cn/.test(footer)) {
      const anchor = '<p class="footer-support">';
      const at = h.indexOf(anchor, fs2);
      if (at >= 0) {
        const lineEnd = h.indexOf('\n', at);
        h = `${h.slice(0, lineEnd + 1)}      ${LINK_LABELED}\n      · <a href="help.html">使用帮助</a>\n${h.slice(lineEnd + 1)}`;
      } else {
        // 没有 footer-support 就在 </footer> 前插一段
        h = `${h.slice(0, fe)}  <p class="footer-support">${LINK_LABELED}</p>\n  ${h.slice(fe)}`;
      }
    }
  }

  if (h !== before) {
    fs.writeFileSync(f, h, 'utf8');
    changed += 1;
    console.log(`✏️  ${f}`);
  } else {
    console.log(`✅ ${f}（无需改动）`);
  }
}
console.log(`\n共修改 ${changed} 个页面\n`);

console.log('=== 最终核对（每页页脚三要素）===');
let bad = 0;
for (const f of pages) {
  if (!fs.existsSync(f)) continue;
  const h = fs.readFileSync(f, 'utf8');
  const fs2 = h.indexOf('site-footer');
  const footer = fs2 >= 0 ? h.slice(fs2, h.indexOf('</footer>', fs2)) : '';
  const company = footer.includes('我心永恒（北京）网络科技有限公司版权所有');
  const label = footer.includes('客户留言：');
  const oldEnglish = /Q Thought, Voice, Question/.test(h);
  const ok = company && label && !oldEnglish;
  if (!ok) bad += 1;
  console.log(`  ${f.padEnd(16)} 版权:${company ? '✅' : '❌'} 客户留言:${label ? '✅' : '❌'} 旧英文:${oldEnglish ? '❌' : '✅无'} ${ok ? '' : '← 需处理'}`);
}
console.log(bad === 0 ? '\n✅ 10 个页面页脚全部统一' : `\n❌ 仍有 ${bad} 个页面不达标`);
