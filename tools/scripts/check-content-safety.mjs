/**
 * 内容安全本地词表的**对抗性测试**
 *
 * 为什么需要：词表"有 96 个词"不等于"能挡住规避写法"。UGC 审核的真正风险在于
 * 用户用空格、全角、零宽字符、繁体、同音字绕过 —— 而这些恰恰是最常见的绕过手法。
 * 本脚本把每种绕过手法都跑一遍，并同时检查**误伤**（正常内容不能被拦），
 * 目的不是"证明它很好"，而是**量化它到底挡住了什么、漏了什么**。
 *
 * 用法：在 server 目录下执行 node ../tools/scripts/check-content-safety.mjs
 */
import { localCheck } from '../../server/src/services/content-safety.js';

/** 每条：[说明, 文本, 期望是否被拦（block）] */
const CASES = [
  // ---- 原文直击（基线：必须能拦） ----
  ['原文·引流', '加微信 xxx 详聊', true],
  ['原文·涉赌', '这里可以赌博', true],
  ['原文·涉黄', '提供色情服务', true],
  ['原文·涉毒', '出售毒品', true],
  ['原文·诈骗', '刷单返利日入千元', true],

  // ---- 规避手法一：插空格 ----
  ['插空格·引流', '加 微 信 详 聊', true],
  // ---- 规避手法二：插符号 ----
  ['插符号·引流', '加*微*信*详*聊', true],
  // ---- 规避手法三：零宽字符 ----
  ['零宽字符·引流', '加微\u200b信详聊', true],
  // ---- 规避手法四：全角字母/数字 ----
  ['全角·引流', '加ＷＸ详聊', true],
  ['全角数字·诈骗', '刷单返利日入１０００元', true],
  // ---- 规避手法五：同音字 ----
  ['同音字·引流', '加威信详聊', true],
  // ---- 规避手法六：繁体 ----
  ['繁体·涉赌', '這裡可以賭博', true],
  ['繁体·涉毒', '出售毒品', true],
  // ---- 规避手法七：拼音/缩写 ----
  ['拼音缩写·引流', '加wx详聊', true],
  ['首字母·引流', '加v详聊', true],

  // ---- 误伤检查（正常内容绝不能被拦） ----
  ['正常·保险咨询', '我想问一下保险合同里的免责条款怎么看', false],
  ['正常·情感求助', '女朋友三天没回我消息，我该怎么办', false],
  ['正常·正常含"加"字', '我加了两天班，想请教怎么和领导沟通', false],
  ['正常·正常含"微信"字', '我们公司要求用微信发周报，这算不算加班', false],
  ['正常·正常含"赌"字', '我爸沉迷打麻将赌钱，家里怎么办', false],
  ['正常·银行相关', '我想了解一下银行存款利率', false],

  // ---- 2026-10-11 新增三类：未成年人(block) / 广告法(review) / 歧视攻击(review) ----
  // 注意：广告法与歧视攻击是 **review 而不是 block** —— 目的是"进复核队列"而非"拦住用户"，
  // 所以这里断言的是 action 至少到 review，而不是 block（见下方 expectBlock=false 但期望 action）。
  ['未成年·违规', '想认识未成年女生', true],
  ['未成年·变体', '有在校学生妹兼职', true],
];

console.log('=== 内容安全：本地词表对抗性测试 ===\n');
let pass = 0;
const fails = [];

for (const [label, text, expectBlock] of CASES) {
  const r = localCheck(text, { field: 'profile' }); // profile 是最严的策略（引流也 block）
  if (expectBlock === null) continue;
  const blocked = r.action === 'block';
  const ok = blocked === expectBlock;
  if (ok) pass += 1;
  else fails.push({ label, text, expectBlock, blocked, action: r.action, cats: r.categories });
  const shown = text.replace(/[\u200b-\u200f\ufeff]/g, '⟪零宽⟫').slice(0, 26);
  console.log(
    `${ok ? '✅' : '❌'} ${label.padEnd(16)} 期望=${expectBlock ? '拦' : '放'} 实际=${blocked ? '拦' : '放'}  [${r.action}]  ${shown}${blocked ? `  ← ${r.categories.join('、')}` : ''}`,
  );
}

const total = CASES.length;
console.log('');
console.log(`=== 汇总：${pass}/${total} 符合预期 ===`);

/*
 * 第二部分：新增类别的"**复核级**命中"检查。
 *
 * 为什么单独跑一遍：广告法违禁词与歧视攻击是 `review`（进复核队列）而不是 `block`（拦用户），
 * 用上面那套"期望拦/放"的断言表达不了"应当命中但不该拦"。
 * 这里直接断言 action === 'review'，避免以后有人把 severity 改成 block 而无人发现
 * （那会造成大面积误伤：用户自我介绍里写"我绝对不抽烟"也会被拦）。
 */
console.log('');
console.log('=== 复核级类别（应当命中，但**不拦用户**）===');
const REVIEW_CASES = [
  ['广告法·最高级表述', '我的相亲技巧全网第一', '广告法'],
  ['广告法·绝对化', '这套方法100%有效', '广告法'],
  ['歧视攻击', '滚回你的国家', '歧视攻击'],
];
let reviewPass = 0;
for (const [label, text, expectCat] of REVIEW_CASES) {
  const r = localCheck(text, { field: 'profile' });
  const hit = r.categories.includes(expectCat);
  const isReview = r.action === 'review';
  const ok = hit && isReview;
  if (ok) reviewPass += 1;
  console.log(
    `${ok ? '✅' : '❌'} ${label.padEnd(18)} 命中=${hit ? expectCat : r.categories.join('、') || '无'} action=${r.action}（应为 review）`,
  );
}
console.log(`=== 复核级：${reviewPass}/${REVIEW_CASES.length} 符合预期 ===`);

console.log('');
if (fails.length) {
  console.log('\n不符合预期的用例（这些就是真实覆盖缺口）：');
  for (const f of fails) {
    const kind = f.expectBlock && !f.blocked ? '漏放（绕过成功）' : '误伤（正常内容被拦）';
    console.log(`  · [${kind}] ${f.label}：${f.text.replace(/[\u200b-\u200f\ufeff]/g, '⟪零宽⟫')}`);
    console.log(`      期望=${f.expectBlock ? '拦' : '放'}，实际=${f.blocked ? '拦' : '放'}（action=${f.action}）`);
  }
} else {
  console.log('全部通过 ✅');
}
process.exit(fails.length || reviewPass !== REVIEW_CASES.length ? 1 : 0);
