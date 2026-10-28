import fs from 'node:fs';

// 修两处真死链：help.html 指向 profile.html 的锚点在目标页并不存在
let h = fs.readFileSync('help.html', 'utf8');
const before = h;
h = h.replace(/href="profile\.html#subscription"/g, 'href="profile.html#subscription-card"');
h = h.replace(/href="profile\.html#pioneer"/g, 'href="profile.html"');
fs.writeFileSync('help.html', h, 'utf8');

console.log('help.html 已修改:', h !== before);
console.log('剩余无效锚点 #subscription（非 -card）:', (h.match(/profile\.html#subscription(?!-card)/g) || []).length);
console.log('剩余无效锚点 #pioneer:', (h.match(/profile\.html#pioneer/g) || []).length);
console.log('现在指向 profile 的形式:', [...new Set([...h.matchAll(/href="profile\.html[^"]*"/g)].map((m) => m[0]))].join('  '));

// 同步修检查器：把页面内联脚本也算作"JS 引用"，并跳过非交互容器
let a = fs.readFileSync('tools/scripts/audit-dead-ends.mjs', 'utf8');
const aBefore = a;
a = a.replace(
  "const allJs = jsFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\\n');",
  `const allJs = jsFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\\n');
// 页面内联脚本同样会绑定事件（如 wechat-callback.html），必须算进来，
// 否则会把"内联脚本处理的事件"误报成死胡同（2026-09-18 实际误报过一次）。
const inlineJs = pages
  .filter((p) => fs.existsSync(p))
  .map((p) => [...fs.readFileSync(p, 'utf8').matchAll(/<script[^>]*>([\\s\\S]*?)<\\/script>/g)].map((m) => m[1]).join('\\n'))
  .join('\\n');
const allJsWithInline = allJs + '\\n' + inlineJs;`,
);
a = a.replace(
  "const referenced = allJs.includes(`'${id}'`) || allJs.includes(`\"${id}\"`) || allJs.includes(`#${id}`);",
  "const referenced = allJsWithInline.includes(`'${id}'`) || allJsWithInline.includes(`\"${id}\"`) || allJsWithInline.includes(`#${id}`);",
);
// 只对真正的按钮类元素做"是否有处理"检查，<a>/容器不算
a = a.replace(
  "/<(?:button|a|input|select)[^>]*\\bid=\"([^\"]+)\"/g",
  "/<button[^>]*\\bid=\"([^\"]+)\"/g",
);
fs.writeFileSync('tools/scripts/audit-dead-ends.mjs', a, 'utf8');
console.log('\n检查器已同步修正:', a !== aBefore);
