import fs from 'node:fs';

const c = fs.readFileSync('css/styles.css', 'utf8');
const chk = (n, ok) => console.log(`${ok ? '✅' : '❌'} ${n}`);

const logoText = /\.logo-text \{[\s\S]*?\n\}/.exec(c)?.[0] || '';
const logoTitle = /\.logo-title \{[\s\S]*?\n\}/.exec(c)?.[0] || '';
const logoSub = /\.logo-sub \{[\s\S]*?\n\}/.exec(c)?.[0] || '';

console.log('=== .logo-text ===');
console.log(logoText);
console.log('=== .logo-title ===');
console.log(logoTitle);
console.log('=== .logo-sub ===');
console.log(logoSub);
console.log('');

chk('.logo-text 不再带 letter-spacing（补偿已挪走）', !/letter-spacing/.test(logoText));
chk('.logo-text 仍是竖排 + 居中', /flex-direction: column/.test(logoText) && /align-items: center/.test(logoText));
chk('.logo-title 有 letter-spacing: 1em', /letter-spacing: 1em/.test(logoTitle));
chk('.logo-title 有 margin-right: -1em 抵消末字间距', /margin-right: -1em/.test(logoTitle));
chk('.logo-sub 保持 1.24rem 小字号', /font-size: 1\.24rem/.test(logoSub));
chk('CSS 括号配平', (c.match(/\{/g) || []).length === (c.match(/\}/g) || []).length);

// 10 个页面的标签是否一致
const files = ['index.html', 'account.html', 'report.html', 'wheel.html', 'profile.html', 'pitfalls.html', 'help.html', 'download.html', 'privacy.html', '404.html'];
const want = '<div class="logo-text"><span class="logo-title">Q问</span><span class="logo-sub">问出爱情真谛</span></div>';
let allOk = true;
for (const f of files) {
  const h = fs.readFileSync(f, 'utf8');
  const m = /<div class="logo-text">[\s\S]*?<\/div>/.exec(h);
  if (!m || m[0] !== want) {
    allOk = false;
    console.log(`  ❌ ${f}: ${m ? m[0] : '(未找到)'}`);
  }
}
chk('10 个页面 logo 标记一致', allOk);
