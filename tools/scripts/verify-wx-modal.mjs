import fs from 'node:fs';

const chk = (n, ok) => console.log(`${ok ? '✅' : '❌'} ${n}`);

const au = fs.readFileSync('js/auth.js', 'utf8');
const a = fs.readFileSync('js/account.js', 'utf8');
const h = fs.readFileSync('account.html', 'utf8');
const c = fs.readFileSync('css/styles.css', 'utf8');

chk('auth.js 使用微信内嵌二维码 wxLogin', au.includes('new window.WxLogin({'));
chk('auth.js self_redirect: false（顶层页面跳转）', /self_redirect: false/.test(au));
chk('auth.js 保留整页扫码兜底', au.includes('location.href = cfg.loginUrl'));
chk('auth.js 导出 closeWechatLoginModal', /export function closeWechatLoginModal/.test(au));
chk('auth.js 动态加载 wxLogin.js', au.includes('res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js'));
chk('account.js 从 auth.js 引入 closeWechatLoginModal', /closeWechatLoginModal/.test((/import \{[\s\S]*?\} from '\.\/auth\.js'/.exec(a) || [''])[0]));
chk('account.js 绑定关闭按钮/遮罩', a.includes('[data-close-wx-login]'));
chk('account.html 有弹窗容器', h.includes('id="wx-login-modal"'));
chk('account.html 有内嵌容器', h.includes('id="wx-login-box"'));
chk('styles.css 有 .wx-login-box / .wx-login-frame', c.includes('.wx-login-box') && c.includes('.wx-login-frame'));
chk('styles.css 括号配平', (c.match(/\{/g) || []).length === (c.match(/\}/g) || []).length);
chk('logo 居中规则仍在', /\.logo-text \{[\s\S]*?align-items: center/.test(c));

// 包内不该出现 Vue/JSX 之类；这里只确认没有把 iframe 写成 self_redirect:true
chk('没有误用 self_redirect: true', !/self_redirect: true/.test(au));
