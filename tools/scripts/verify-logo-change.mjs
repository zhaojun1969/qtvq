import fs from 'node:fs';
import tarfile from 'node:child_process';

// ---- 1) 源码侧校验 ----
const css = fs.readFileSync('css/styles.css', 'utf8');
console.log('括号配平:', (css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length ? 'OK' : '❌');
console.log('.logo-text 竖排:', /\.logo-text \{[^}]*flex-direction: column/.test(css));
console.log('副标题字号未改(1.24rem):', /\.logo-text span \{[^}]*font-size: 1\.24rem/.test(css));

const files = ['index.html', 'account.html', 'report.html', 'wheel.html', 'profile.html', 'pitfalls.html', 'help.html', 'download.html', 'privacy.html', '404.html'];
console.log('\n=== 10 个页面的 logo 区块 ===');
let allOk = true;
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  const m = /<div class="logo-text">[\s\S]*?<\/div>/.exec(t);
  const ok = m && m[0] === '<div class="logo-text">Q问<span>问出爱情真谛</span></div>';
  if (!ok) allOk = false;
  console.log(`  ${f.padEnd(16)} ${ok ? '✅ 统一' : `❌ ${m ? m[0] : '(未找到)'}`}`);
}
console.log(`\n  10 个页面是否全部统一：${allOk ? '是 ✅' : '否 ❌'}`);

// ---- 2) 包内校验（用 python 更省事，这里调一次）----
import('node:child_process').then(() => {});
