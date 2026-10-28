import fs from 'node:fs';

const chk = (n, ok) => console.log(`${ok ? '✅' : '❌'} ${n}`);
const h = fs.readFileSync('help.html', 'utf8');

chk('会员与支付：在线支付写的是"自动开通"', h.includes('微信在线支付（推荐，自动开通）'));
chk('会员与支付：静态码已改为"两种"（原写四种，已错）', h.includes('现为两种：微信支付、聚合码') && !h.includes('四种收款码'));
chk('会员与支付：按钮名称与实际一致（我已付款 · 提交核实）', h.includes('我已付款 · 提交核实'));
chk('新增 ④ 缘值充值（自动到账）', h.includes('缘值充值（转盘与配对报告用）'));
chk('新增 ⑤ 两笔钱互不通用', h.includes('请分清两笔钱（互不通用）'));
chk('新增 账号与安全 一节', h.includes('id="account"'));
chk('账号与安全：三种登录方式', h.includes('微信扫码登录') && h.includes('手机号 + 密码'));
chk('账号与安全：短信找回密码（含节流说明）', h.includes('同一号码 60 秒只能获取一次'));
chk('账号与安全：语音输入与麦克风权限', h.includes('浏览器会请求麦克风权限'));
chk('账号与安全：注销后果 + 脱敏保留', h.includes('脱敏方式'));
chk('导航已接好：会员→账号→客服', h.includes('下一节：账号与安全') && /#account[\s\S]{0,80}上一节/.test(h));

const openSec = (h.match(/<section/g) || []).length;
const closeSec = (h.match(/<\/section>/g) || []).length;
chk(`<section> 成对（${openSec}/${closeSec}）`, openSec === closeSec);
const openCard = (h.match(/<div class="help-card">/g) || []).length;
console.log(`   （help-card 数量：${openCard}）`);
