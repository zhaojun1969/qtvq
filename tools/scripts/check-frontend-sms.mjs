import fs from 'node:fs';

const a = fs.readFileSync('js/account.js', 'utf8');
const au = fs.readFileSync('js/auth.js', 'utf8');
const h = fs.readFileSync('account.html', 'utf8');
const c = fs.readFileSync('css/styles.css', 'utf8');
const pq = fs.readFileSync('js/pay-qr.js', 'utf8');

const chk = (n, ok) => console.log(`${ok ? '✅' : '❌'} ${n}`);

chk('auth.js 导出 sendSmsCode', /export async function sendSmsCode/.test(au));
chk('auth.js 导出 resetPasswordBySms', /export async function resetPasswordBySms/.test(au));
chk('auth.js 导出 fetchSmsStatus', /export async function fetchSmsStatus/.test(au));
chk('auth.js fetchAccountMe 未被破坏（仍有 token 取值）', /export async function fetchAccountMe\(\) \{\s*\n\s*const token = getAuthToken\(\);/.test(au));
chk('account.js 导入了 sendSmsCode', a.includes('sendSmsCode,'));
chk('account.js 导入了 resetPasswordBySms', a.includes('resetPasswordBySms,'));
chk('account.js 导入了 fetchSmsStatus', a.includes('fetchSmsStatus,'));
chk('account.js 绑定 btn-send-sms', /getElementById\('btn-send-sms'\)\?\.addEventListener/.test(a));
chk('account.js 绑定 forgot-form submit', /getElementById\('forgot-form'\)\?\.addEventListener\('submit'/.test(a));
chk('account.js 有 60 秒倒计时', a.includes('秒后可重发'));
chk('account.html 有验证码输入框', h.includes('name="code"'));
chk('account.html 有 code-row 布局', h.includes('code-row'));
chk('account.html 有 btn-send-sms', h.includes('btn-send-sms'));
chk('account.html 保留微信扫码重置', h.includes('btn-wechat-open-reset'));
chk('styles.css 有 .code-row', c.includes('.code-row'));
chk('styles.css 有 sticky 操作行', /pay-qr-viewer-actions[\s\S]{0,260}sticky/.test(c));
chk('styles.css 有 pre-line', /pay-qr-viewer-tip[\s\S]{0,160}pre-line/.test(c));
chk('pay-qr.js 有 channelTip', pq.includes('channelTip'));

// 关键：检查 functions 里所有相对导入是否真的存在（这次部署失败就是因为写错了层级）
const path = await import('node:path');
let bad = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) {
      const t = fs.readFileSync(p, 'utf8');
      for (const m of t.matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
        if (!fs.existsSync(path.resolve(path.dirname(p), m[1]))) {
          console.log(`❌ 导入路径不存在：${p} -> ${m[1]}`);
          bad += 1;
        }
      }
    }
  }
};
walk('functions');
chk(`functions 下所有相对导入均可解析（${bad} 个错误）`, bad === 0);
