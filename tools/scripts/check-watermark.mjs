/**
 * 水印自检 —— 对应 `server/src/services/watermark.js`。
 *
 * 为什么必须有这个文件：水印是**取证**手段，它悄悄坏掉的后果最严重 ——
 * 平时完全看不出问题（文本照常显示、接口照常 200），
 * 等真的发生泄漏、需要溯源时才发现"解不出来/解错了"，那时已经来不及。
 * 所以每次改动水印实现都必须跑这个自检。
 */
import { selfTest, extractWatermarks, markText, stripWatermark } from '../../server/src/services/watermark.js';

const cases = selfTest();
let pass = 0;
let fail = 0;
for (const [name, ok] of cases) {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}`);
  }
}

/* 额外验证：真实业务流程里的用法（打标 → 泄漏 → 提取） */
const uid = 'u_9d1c4b77aa02e5f3';
const report = '一、整体印象\n他属于慢热型，前两次约会不会主动找话题。\n\n二、相处建议\n建议由你来定第一次见面的地点。';
const leaked = markText(report, uid);
const recovered = extractWatermarks(leaked);
const stripOk = stripWatermark(leaked) === report;
const extra = [
  ['流程：报告打标后能提取出读者 uid', recovered.includes(uid)],
  ['流程：去掉水印后与原文逐字一致（不影响阅读）', stripOk],
];
for (const [name, ok] of extra) {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}`);
  }
}

console.log(`\n  通过 ${pass} · 失败 ${fail}`);
if (fail > 0) {
  console.error('\n❌ 水印自检未通过 —— 这会让泄漏溯源静默失效，必须先修好再部署。');
  process.exit(1);
}
console.log('✅ 水印自检全部通过');
