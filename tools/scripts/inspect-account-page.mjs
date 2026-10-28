import fs from 'node:fs';

const t = fs.readFileSync('apps/qtvq-uni/src/pages/account/account.vue', 'utf8');
const L = t.split(/\r?\n/);
console.log('总行数:', L.length);

console.log('\n=== 模板区块（section-title / title / 面板）===');
L.forEach((l, i) => {
  if (/section-title|<text class="title"|panel-title|v-if="mode/.test(l)) {
    console.log(`  ${i + 1}: ${l.trim().slice(0, 100)}`);
  }
});

console.log('\n=== 状态与函数 ===');
L.forEach((l, i) => {
  if (/^(const|let) \w+ = ref|^(async )?function \w+|^(async )?function/.test(l.trim())) {
    console.log(`  ${i + 1}: ${l.trim().slice(0, 100)}`);
  }
});

console.log('\n=== import 行 ===');
L.forEach((l, i) => {
  if (/^import /.test(l.trim())) console.log(`  ${i + 1}: ${l.trim().slice(0, 110)}`);
});
