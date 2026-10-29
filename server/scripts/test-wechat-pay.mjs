#!/usr/bin/env node
/**
 * 微信支付 V3（server 侧）验收用例 —— 2026-10-27
 *
 * 覆盖《再改造技术实施书》P0-T0.1 验收标准：
 *   ① 重复回调只入账一次（钱包只加一次钱）
 *   ② 验签失败拒绝
 *   ③ 金额不符拒绝（不改变订单状态，只记账告警）
 *   ④ 主动查询补入账走同一幂等路径
 *
 * ── 为什么这套用例能在没有微信商户号的环境跑 ─────────────────────────────
 * 它**自己生成一对 RSA 密钥**当作"商户私钥/微信支付公钥"，并用 APIv3 密钥
 * 按微信的规则（AEAD_AES_256_GCM）加密 resource —— 这样构造出来的回调在
 * 密码学上与真实回调同构。测的是我们的验签/解密/幂等逻辑，不是微信的。
 *
 * 用法（需要在能连 Mongo 的机器上跑）：
 *   cd server && node scripts/test-wechat-pay.mjs
 */
import crypto from 'node:crypto';
import 'dotenv/config';

/* ---------------------------------------------------------------- 测试密钥 */

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const API_V3_KEY = crypto.randomBytes(16).toString('hex'); // 32 字符 = 32 字节
process.env.WECHAT_APP_ID = 'wxtest_appid';
process.env.WECHAT_MCH_ID = '1113936939';
process.env.WECHAT_API_V3_KEY = API_V3_KEY;
process.env.WECHAT_MCH_SERIAL = 'TESTMCHSERIAL1234';
process.env.WECHAT_MCH_PRIVATE_KEY = privateKey;
process.env.WECHAT_PLATFORM_PUBLIC_KEY = publicKey;
process.env.WECHAT_PAY_NOTIFY_URL = 'https://qtvq.cn/v1/payment/wechat/notify';

const { encryptWechatResource, rsaSignBase64 } = await import('../src/lib/wechat-crypto.js');
const { verifyNotify, isWechatPayConfigured } = await import('../src/services/wechat-pay.js');
const { createOrder, markPaid, getOrder, ensureOrderIndexes } = await import('../src/services/orders.js');
const wallet = await import('../src/services/wallet.js');
const { getDB: getDb2, connectDB, closeDB: closeDb2 } = await import('../src/config/db.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 构造一条"密码学上合法"的微信回调 */
function buildNotify({ outTradeNo, amountFen, transactionId, signWith = privateKey, apiV3Key = API_V3_KEY }) {
  const tx = {
    out_trade_no: outTradeNo,
    transaction_id: transactionId,
    trade_state: 'SUCCESS',
    amount: { total: amountFen, currency: 'CNY' },
  };
  const nonce = crypto.randomBytes(6).toString('hex'); // 12 字符
  const associatedData = 'transaction';
  const ciphertext = encryptWechatResource(apiV3Key, { associatedData, nonce, plaintext: JSON.stringify(tx) });
  const body = JSON.stringify({
    id: crypto.randomUUID(),
    event_type: 'TRANSACTION.SUCCESS',
    resource: { algorithm: 'AEAD_AES_256_GCM', ciphertext, associated_data: associatedData, nonce },
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const headerNonce = crypto.randomBytes(8).toString('hex');
  const signature = rsaSignBase64(signWith, `${timestamp}\n${headerNonce}\n${body}\n`);
  return {
    body,
    headers: {
      'wechatpay-timestamp': timestamp,
      'wechatpay-nonce': headerNonce,
      'wechatpay-signature': signature,
      'wechatpay-serial': 'PUB_KEY_ID_TEST',
    },
  };
}

async function main() {
  await connectDB();
  await ensureOrderIndexes();
  console.log(`\n微信支付 V3 server 侧验收（商户号配置：${isWechatPayConfigured() ? '已配置' : '未配置'}）\n`);

  const uid = `u_wxtest_${Date.now().toString(36)}`;
  const amountFen = 990; // ¥9.9 diagnose

  /*
   * ① 正常回调入账 —— 用**缘值充值单**（topup）验证。
   *
   * 2026-10-29 修正：这条用例原来用的 sku 是 diagnose，并断言"钱包余额增加 9.9"。
   * 那个断言本身就在描述 bug —— 报告单付了钱不该再把钱折回钱包（等于报告免费，
   * 可以无限刷）。现在只有 topup 单才入账，所以用例必须换成 topup，
   * 另外补一条"报告单支付后余额不变"的反向断言。
   */
  const order = await createOrder({ uid, sku: 'topup', amountFen, channel: 'native' });
  const before = await wallet.getBalance(uid);
  const notify = buildNotify({ outTradeNo: order.orderId, amountFen, transactionId: 'wx_tx_001' });

  const v = verifyNotify(notify.headers, notify.body);
  check('合法回调验签 + 解密成功', v.ok, v.error);
  check('解密出的订单号正确', v.outTradeNo === order.orderId, `${v.outTradeNo} ≠ ${order.orderId}`);

  const settled = await markPaid({ orderId: order.orderId, transactionId: v.transactionId, amountFen: v.amountTotal });
  check('首次回调入账成功', settled.settled === true && !settled.duplicate);
  const after = await wallet.getBalance(uid);
  check('钱包余额增加 9.9', Math.abs(after - before - 9.9) < 1e-6, `before=${before} after=${after}`);

  /* ①b 报告单：支付成功但**不**折回余额 */
  const reportOrder = await createOrder({ uid, sku: 'diagnose', amountFen: 490, channel: 'native' });
  const balBeforeReport = await wallet.getBalance(uid);
  const reportNotify = buildNotify({ outTradeNo: reportOrder.orderId, amountFen: 490, transactionId: 'wx_tx_report_001' });
  const vReport = verifyNotify(reportNotify.headers, reportNotify.body);
  check('报告单回调验签成功', vReport.ok, vReport.error);
  const reportSettled = await markPaid({ orderId: reportOrder.orderId, transactionId: 'wx_tx_report_001', amountFen: 490 });
  const balAfterReport = await wallet.getBalance(uid);
  check('报告单支付成功（订单 paid）', reportSettled.settled === true && (await getOrder(reportOrder.orderId)).status === 'paid');
  check('报告单支付后余额不变（不折回钱包）', Math.abs(balAfterReport - balBeforeReport) < 1e-6, `${balBeforeReport} → ${balAfterReport}`);

  /* ② 重复回调只入账一次 */
  const dup = await markPaid({ orderId: order.orderId, transactionId: v.transactionId, amountFen: v.amountTotal });
  const afterDup = await wallet.getBalance(uid);
  check('重复回调被识别为 duplicate', dup.duplicate === true && dup.settled === false);
  check('重复回调没有再加钱', Math.abs(afterDup - after) < 1e-6, `after=${after} afterDup=${afterDup}`);
  const doc = await getOrder(order.orderId);
  check('订单状态为 paid', doc.status === 'paid', doc.status);
  check('回调计数累加到 2', doc.notifyCount === 2, String(doc.notifyCount));

  /* ③ 验签失败拒绝 */
  const wrongKey = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).privateKey;
  const badSig = buildNotify({ outTradeNo: order.orderId, amountFen, transactionId: 'wx_tx_bad', signWith: wrongKey });
  const vBad = verifyNotify(badSig.headers, badSig.body);
  check('错误私钥签的回调被拒', vBad.ok === false && /验签失败/.test(vBad.error || ''), vBad.error);

  const tampered = { ...notify.headers, 'wechatpay-signature': notify.headers['wechatpay-signature'].slice(0, -4) + 'AAAA' };
  const vTamper = verifyNotify(tampered, notify.body);
  check('篡改签名被拒', vTamper.ok === false, vTamper.error);

  /* ④ 金额不符拒绝 */
  const order2 = await createOrder({ uid, sku: 'retro', amountFen: 1990, channel: 'native' });
  const wrongAmount = await markPaid({ orderId: order2.orderId, transactionId: 'wx_tx_002', amountFen: 1 });
  const doc2 = await getOrder(order2.orderId);
  check('金额不符被标记 mismatch', wrongAmount.mismatch === true);
  check('金额不符时订单仍是 created', doc2.status === 'created', doc2.status);
  check('金额不符写入了告警字段', !!doc2.amountMismatch, JSON.stringify(doc2.amountMismatch || null));
  const balAfterMismatch = await wallet.getBalance(uid);
  check('金额不符没有入账', Math.abs(balAfterMismatch - afterDup) < 1e-6);

  /* ⑤ 未知订单（不属于新栈）应识别为 notFound，不报错 */
  const ghost = await markPaid({ orderId: 'rpt_does_not_exist', transactionId: 'x', amountFen: 100 });
  check('未知订单返回 notFound', ghost.notFound === true);

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  await closeDb2();
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error('用例执行异常：', err);
  try {
    await closeDb2();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
