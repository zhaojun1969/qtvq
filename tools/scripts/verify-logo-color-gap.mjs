import fs from 'node:fs';

const chk = (n, ok) => console.log(`${ok ? '✅' : '❌'} ${n}`);
const c = fs.readFileSync('css/styles.css', 'utf8');

const open = (c.match(/\{/g) || []).length;
const close = (c.match(/\}/g) || []).length;
chk(`CSS 花括号配平（${open} 开 / ${close} 闭）`, open === close);

const title = /\.logo-title \{[\s\S]*?\n\}/.exec(c)?.[0] || '';
const sub = /\.logo-sub \{[\s\S]*?\n\}/.exec(c)?.[0] || '';

chk('.logo-title 字间距为 2em（各向外一格 → 中间两格）', /letter-spacing: 2em/.test(title));
chk('.logo-title 补偿 -2em', /margin-right: -2em/.test(title));
chk('.logo-title 未设 color（沿用原色）', !/color:/.test(title));
chk('.logo-title 未设 font-size（沿用原字号）', !/font-size:/.test(title));
chk('.logo-sub 仍是 1.24rem 灰色副标题', /font-size: 1\.24rem/.test(sub) && /color: var\(--text-muted\)/.test(sub));
chk('已无 .logo-text span 通配规则（正是它把标题染灰的）', !/\.logo-text span\s*\{/.test(c));

// 页面结构不变
const h = fs.readFileSync('index.html', 'utf8');
chk('index.html 标题为 .logo-title', h.includes('<span class="logo-title">Q问</span>'));
chk('index.html 副标题为 .logo-sub', h.includes('<span class="logo-sub">问出爱情真谛</span>'));
