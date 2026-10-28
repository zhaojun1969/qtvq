const t = Date.now();
const get = async (f) => (await fetch(`https://qtvq.cn/${f}?v=${t}`)).text();
const chk = (n, ok) => console.log(`${ok ? '✅' : '❌'} ${n}`);

const v = await get('js/version.js');
console.log('BUILD_TIME:', (v.match(/BUILD_TIME = '([^']+)'/) || [])[1], '\n');

const auth = await get('js/auth.js');
chk('auth.js 已上线内嵌二维码实现（wxLogin）', auth.includes('new window.WxLogin({'));
chk('auth.js self_redirect: false', /self_redirect: false/.test(auth));
chk('auth.js 保留整页扫码兜底', auth.includes('location.href = cfg.loginUrl'));
chk('auth.js 导出 closeWechatLoginModal', /export function closeWechatLoginModal/.test(auth));

const acc = await get('account.html');
chk('account.html 有扫码弹窗容器', acc.includes('id="wx-login-modal"'));
chk('account.html 有充值面板', acc.includes('topup-panel'));
chk('account.html 含短信找回 UI', acc.includes('btn-send-sms'));
chk('account.html 含注销区', acc.includes('danger-zone'));

const acj = await get('js/account.js');
chk('account.js 引入 closeWechatLoginModal', /closeWechatLoginModal,/.test(acj));
chk('account.js 绑定关闭事件', acj.includes('[data-close-wx-login]'));
chk('account.js 含充值逻辑 initTopup', acj.includes('initTopup'));

const css = await get('css/styles.css');
const rule = /\.logo-text \{[\s\S]*?\}/.exec(css);
chk('logo 居中仍生效', rule ? /align-items: center/.test(rule[0]) : false);
chk('扫码弹窗样式已上线', css.includes('.wx-login-frame'));
chk('副标题字号未变(1.24rem)', /\.logo-text span \{[\s\S]{0,120}font-size: 1\.24rem/.test(css));

const cb = await get('wechat-callback.html');
chk('微信回调诊断页仍在线', cb.includes('cb-detail'));
