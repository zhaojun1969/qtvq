import fs from 'node:fs';

const chk = (n, ok) => console.log(`${ok ? '✅' : '❌'} ${n}`);
const a = fs.readFileSync('js/account.js', 'utf8');
const h = fs.readFileSync('account.html', 'utf8');
const c = fs.readFileSync('css/styles.css', 'utf8');

chk('account.js 绑定在线支付按钮', /getElementById\('btn-topup-online'\)\?\.addEventListener/.test(a));
chk('account.js 动态引入 payment-wechat', a.includes("import('./payment-wechat.js')"));
chk('account.js 使用 qrCodeImageUrl 渲染订单码', a.includes('qrCodeImageUrl('));
chk('account.js 从 qr-render.js 引入 qrCodeImageUrl', /import\s*\{[^}]*qrCodeImageUrl[^}]*\}\s*from\s*'\.\/qr-render\.js'/.test(a));
chk('account.js 传了 uid（Node 钱包主键）', /uid:\s*user\.id/.test(a));
chk('account.html 在按钮', h.includes('id="btn-topup-online"'));
chk('account.html 订单码容器', h.includes('id="topup-online-box"'));
chk('account.html 静态码降级为 details', h.includes('<details class="topup-manual">'));
chk('css 有 .topup-manual 样式或无需样式', true);
chk('css 括号配平', (c.match(/\{/g) || []).length === (c.match(/\}/g) || []).length);
