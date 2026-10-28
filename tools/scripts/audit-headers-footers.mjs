import fs from 'node:fs';

const pages = ['index.html', 'pitfalls.html', 'profile.html', 'wheel.html', 'report.html', 'account.html', 'help.html', 'download.html', 'privacy.html', '404.html'];

console.log('=== 页头 logo（应统一为新版）===');
for (const f of pages) {
  const h = fs.readFileSync(f, 'utf8');
  const m = /<div class="logo-text">[\s\S]*?<\/div>/.exec(h);
  const ok = m && m[0].includes('logo-title') && m[0].includes('问出爱情真谛');
  const old = /我心永恒<span>|Q问 · qtvq.cn/.test(h);
  console.log(`  ${f.padEnd(16)} ${ok ? '✅ 新版' : '❌ ' + (m ? m[0].slice(0, 70) : '(未找到)')}${old ? '   ⚠️ 仍含旧文案' : ''}`);
}

console.log('\n=== 页脚：公司名 / 邮箱 / 旧文案 ===');
for (const f of pages) {
  const h = fs.readFileSync(f, 'utf8');
  const footerStart = h.indexOf('site-footer');
  const footer = footerStart >= 0 ? h.slice(footerStart) : '';
  const hasCompany = /我心永恒（北京）网络科技有限公司/.test(footer);
  const emails = [...new Set([...footer.matchAll(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi)].map((m) => m[0]))];
  const has6166 = /6166@6166\.cn/i.test(h);
  const hasVoiceQ = /Q Thought, Voice, Question/.test(h);
  console.log(
    `  ${f.padEnd(16)} 公司名:${hasCompany ? '有' : '❌无'}  邮箱:${emails.join(',') || '(无)'}${has6166 ? '  ⚠️含6166邮箱' : ''}${hasVoiceQ ? '  ⚠️含旧英文' : ''}`,
  );
}

console.log('\n=== 全站 6166 相关残留 ===');
for (const f of pages) {
  const h = fs.readFileSync(f, 'utf8');
  const hits = [...h.matchAll(/[^\s"'<>]*6166[^\s"'<>]*/g)].map((m) => m[0]);
  if (hits.length) console.log(`  ${f}: ${[...new Set(hits)].slice(0, 6).join(' | ')}`);
}
