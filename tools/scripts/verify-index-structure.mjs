import fs from 'node:fs';

const chk = (n, ok) => console.log(`${ok ? '✅' : '❌'} ${n}`);
const h = fs.readFileSync('index.html', 'utf8');

chk('在线支付按钮存在', h.includes('id="btn-wechat-online-pay"'));
chk('动态二维码查看器存在（#pay-qr-viewer）', h.includes('id="pay-qr-viewer"'));
chk('查看器里的图片容器存在', h.includes('id="pay-qr-viewer-img"'));
chk('查看器里有「我已付款 · 提交核实」按钮', h.includes('id="btn-pay-done"'));
chk('静态码网格仍在（只是收进折叠区）', h.includes('id="pay-qr-grid"'));

// 标签配对总检（div/section/details/form/ol/ul/li 等常见容器）
const pairs = ['div', 'section', 'details', 'form', 'ul', 'ol', 'li', 'p', 'span', 'a', 'button', 'table', 'tr', 'td'];
let bad = 0;
for (const tag of pairs) {
  const open = (h.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
  const close = (h.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  const ok = open === close;
  if (!ok) {
    bad += 1;
    console.log(`  ❌ <${tag}> 不配对：${open} 开 / ${close} 闭`);
  }
}
chk(`主要标签全部配对（不配对 ${bad} 种）`, bad === 0);

// 查看器是否在订阅弹窗外层（避免被一起收进 details 而不可见）
const viewerIdx = h.indexOf('id="pay-qr-viewer"');
const detailsEnd = h.lastIndexOf('</details>');
chk('查看器不在折叠区内（应在 details 之后）', viewerIdx > detailsEnd);

// 折叠区闭合位置
const detailsOpen = (h.match(/<details/g) || []).length;
const detailsClose = (h.match(/<\/details>/g) || []).length;
chk(`details 成对（${detailsOpen}/${detailsClose}）`, detailsOpen === detailsClose);
