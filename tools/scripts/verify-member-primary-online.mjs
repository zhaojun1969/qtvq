import fs from 'node:fs';

const chk = (n, ok) => console.log(`${ok ? '✅' : '❌'} ${n}`);
const h = fs.readFileSync('index.html', 'utf8');

chk('在线支付按钮仍是主按钮（btn-primary）', /id="btn-wechat-online-pay"[^>]*btn-primary/.test(h));
chk('静态收款码已收进折叠区', h.includes('pay-section-details'));
chk('折叠区标题说明"需人工核实"', /pay-section-details[\s\S]{0,200}需人工核实/.test(h));
chk('折叠区内仍有两个渠道按钮', (h.match(/data-pay-channel="(wechat|aggregate)"/g) || []).length === 2);
chk('对公汇款仍在（嵌套折叠）', h.includes('pay-bank-details'));
chk('汇款表单仍在', h.includes('id="payment-form"'));
chk('顶部提示引导用在线支付', h.includes('推荐用下方「微信在线支付」'));

// 标签平衡粗检（details/summary 是否成对）
const open = (h.match(/<details/g) || []).length;
const close = (h.match(/<\/details>/g) || []).length;
chk(`<details> 标签成对（${open} 开 / ${close} 闭）`, open === close);
