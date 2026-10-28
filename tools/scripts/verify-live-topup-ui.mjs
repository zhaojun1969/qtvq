const t = Date.now();
const get = async (f) => (await fetch(`https://qtvq.cn/${f}?v=${t}`)).text();

const h = await get('account.html');
console.log('=== 静态站（线上）=== ');
console.log('  在线支付按钮 btn-topup-online:', h.includes('btn-topup-online'));
console.log('  订单二维码容器:', h.includes('topup-online-box'));
console.log('  静态收款码已收进折叠区:', h.includes('topup-manual'));

const a = await get('js/account.js');
console.log('  按钮逻辑已上线:', a.includes('btn-topup-online'));
console.log('  qrCodeImageUrl 已引入:', /import\s*\{[^}]*qrCodeImageUrl[^}]*\}/.test(a));
console.log('  传 uid 给订单:', /uid:\s*user\.id/.test(a));

const v = await get('js/version.js');
console.log('  BUILD_TIME:', (v.match(/BUILD_TIME = '([^']+)'/) || [])[1]);
