const t = Date.now();
const get = async (f) => {
  const r = await fetch(`https://qtvq.cn/${f}?v=${t}`);
  return await r.text();
};

const v = await get('js/version.js');
console.log('BUILD_SHA :', (v.match(/BUILD_SHA = '([^']+)'/) || [])[1], ' 构建时间:', (v.match(/BUILD_TIME = '([^']+)'/) || [])[1]);

const css = await get('css/styles.css');
const rule = /\.logo-text \{[\s\S]*?\}/.exec(css);
console.log('\n=== 线上 .logo-text 规则 ===');
console.log(rule ? rule[0] : '(未找到)');
console.log('居中已生效 (align-items: center):', rule ? /align-items: center/.test(rule[0]) : false);
console.log('副标题字号 1.24rem 未变        :', /\.logo-text span \{[\s\S]{0,120}font-size: 1\.24rem/.test(css));

const pages = ['index.html', 'account.html', 'report.html', 'wheel.html', 'profile.html', 'pitfalls.html', 'help.html', 'download.html', 'privacy.html', '404.html'];
console.log('\n=== 10 个页面页头文案 ===');
let allOk = true;
for (const f of pages) {
  const html = await get(f);
  const m = /<div class="logo-text">[\s\S]*?<\/div>/.exec(html);
  const ok = m && m[0] === '<div class="logo-text">Q问<span>问出爱情真谛</span></div>';
  if (!ok) allOk = false;
  const stale = html.includes('Q问 · qtvq.cn');
  console.log(`  ${f.padEnd(16)} ${ok ? '✅ 统一' : `❌ ${m ? m[0].slice(0, 70) : '(未找到)'}`}${stale ? '  ⚠️ 仍含旧文案' : ''}`);
}
console.log(`\n  10 个页面全部统一：${allOk ? '是 ✅' : '否 ❌'}`);

const acc = await get('account.html');
console.log('\n充值面板已上线:', acc.includes('topup-panel'));
const hm = await get('js/home.js');
console.log('语音就绪探测已上线:', hm.includes('probeSpeechApiDetailed'));
