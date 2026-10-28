/**
 * 收款渠道闸门 —— `js/pay-qr.js` 的每个渠道都必须**显式声明** `autoCredit`。
 *
 * 为什么需要它（2026-10-11 两次真实事故）：
 *   两位用户（`u_mu5oimef_08f9ae40`、`u_mu2iknsc_9e550c55`）分别用静态收款码付了 ¥1，
 *   系统里**既没有订单、也没有流水**，两人都来问"我充的钱去哪了"。
 *   根因不是 bug 而是**物理限制**：静态码没有订单号、没有支付回调，无法自动对账。
 *   但原本文案只写"客服核对到账后立即开通"，**读不出"这条通道不会自动到账"**。
 *
 * 于是给渠道加了 `autoCredit` 字段，并加这道闸门，防止两种回退：
 *   ① 以后新增静态码渠道时忘了标 `autoCredit` → 又变成"默认以为会自动到账"的歧义；
 *   ② 标了 `autoCredit: false` 却没写警告文案 → 字段有了，用户还是看不到。
 *
 * 判据（两条都必须满足）：
 *   · 每个渠道有**布尔** `autoCredit`；
 *   · `autoCredit === false` 的渠道，其 `tip` 必须包含"不会自动到账"这句话。
 */
import { PAY_CHANNELS } from '../../js/pay-qr.js';

const REQUIRED_WARNING = '不会自动到账';
const ids = Object.keys(PAY_CHANNELS || {});

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail ? '  → ' + detail : ''}`);
  }
}

check('至少有一个收款渠道', ids.length > 0, `实际 ${ids.length} 个`);

for (const id of ids) {
  const ch = PAY_CHANNELS[id];
  const hasFlag = typeof ch?.autoCredit === 'boolean';
  check(`${id}：显式声明了布尔 autoCredit`, hasFlag, hasFlag ? `autoCredit=${ch.autoCredit}` : `实际类型 ${typeof ch?.autoCredit}（缺失或非布尔）`);

  if (hasFlag && ch.autoCredit === false) {
    const tip = String(ch.tip || '');
    check(`${id}：静态码渠道的 tip 写明了「${REQUIRED_WARNING}」`, tip.includes(REQUIRED_WARNING),
      tip ? 'tip 里没有这句话，用户读不出后果' : 'tip 为空');
  }
}

console.log(`\n  通过 ${pass} · 失败 ${fail}`);
if (fail > 0) {
  console.error('\n❌ 收款渠道声明不完整 —— 用户会以为"付了钱系统就该自动有记录"，而这正是两次投诉的成因。');
  process.exit(1);
}
console.log('✅ 收款渠道声明完整（每个渠道都显式声明了是否自动到账）');
