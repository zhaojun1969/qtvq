/**
 * 「扫码买一份真实报告」：把支付闭环的最后一步（真人扫码付钱）变成可执行的两步。
 *
 * 为什么需要它：
 *   `e2e-report-billing.mjs` 已经把"微信侧下单 → 订单置 paid → 生成报告 → 订单被消费"
 *   全部验过，但**唯独"钱真的从买家账户划走"必须由人完成**（要一台手机扫码）。
 *   以前验这一步要在三个地方手工拼：建单接口、二维码生成、回调后轮询 —— 没人会为
 *   一次验证做这么多手工，于是这一步长期没人验。
 *
 * 这个脚本把它拆成两段，中间留出扫码的时间：
 *   ① `--no-wait`：建单 + 调微信统一下单 + 把 codeUrl 画成 PNG 二维码 → 打印 orderId 与图片路径
 *   ② `--wait --order-id=...`：轮询订单状态；一旦 paid，就用这张订单生成报告并核对结果
 *
 * 跑法（服务器，root —— 要读 secrets/ 下的商户私钥）：
 *   cd /opt/qtvq/server
 *   sudo node --env-file=.env scripts/buy-real-report.mjs --sku=diagnose --qr-out=/tmp/qr.png --no-wait
 *   sudo node --env-file=.env scripts/buy-real-report.mjs --order-id=rpt_xxx --wait --timeout=600
 *
 * 退出码：0 = 已支付并生成成功；3 = 等待超时（订单仍 pending，可重复跑 --wait）；其它 = 出错
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const arg = (name, def = null) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const i = hit.indexOf('=');
  return i === -1 ? true : hit.slice(i + 1);
};

const SKU = String(arg('sku', 'diagnose'));
const UID = String(arg('uid', 'u_rptprobe_billing_001'));
const BASE = String(arg('base', 'http://127.0.0.1:3000'));
const ORDER_ID = arg('order-id', null);
const QR_OUT = String(arg('qr-out', '/tmp/qtvq-real-pay.png'));
const TIMEOUT_S = Number(arg('timeout', 600));
const NO_WAIT = process.argv.includes('--no-wait');
const WAIT_ONLY = process.argv.includes('--wait');

// 相对**本文件**解析，而不是 cwd：这个脚本在 /opt/qtvq/server 下跑，
// 而 qr-render.js 在仓库根的 js/ 里（用 cwd 相对会解析成 /opt/js，实测必炸）
const HERE = path.dirname(fileURLToPath(import.meta.url));
const u = (p) => pathToFileURL(path.resolve(HERE, p)).href;

async function main() {
  const { connectDB, getDB } = await import('../src/config/db.js');
  const { createOrder, getOrder, markPaid } = await import('../src/services/orders.js');
  const { createNativeOrder, isWechatPayConfigured, getWechatPayConfig } = await import('../src/services/wechat-pay.js');
  const { priceFenFor } = await import('../src/services/report-credits.js');
  const { signLocalToken } = await import('../src/middleware/auth.js');
  const { ADULT_AGREEMENT_VER } = await import('../src/middleware/adult.js');

  await connectDB();
  const db = getDB();

  if (!isWechatPayConfigured()) {
    console.error('❌ 微信支付未配置（wechatConfigured=false）。先跑 tools/scripts/upload-wechat-secrets-node.ps1');
    process.exit(2);
  }

  /* ---------------- 第二段：等支付 ---------------- */
  if (WAIT_ONLY || ORDER_ID) {
    if (!ORDER_ID) {
      console.error('❌ --wait 需要 --order-id=<下第一段打印的 orderId>');
      process.exit(2);
    }
    const order = await getOrder(String(ORDER_ID));
    if (!order) {
      console.error(`❌ 订单不存在：${ORDER_ID}`);
      process.exit(2);
    }
    console.log(`等待支付：${order.orderId} · ${order.sku} · ¥${(order.amountFen / 100).toFixed(2)}（最多 ${TIMEOUT_S}s）`);
    const deadline = Date.now() + TIMEOUT_S * 1000;
    let current = order;
    while (Date.now() < deadline && current.status === 'created') {
      await new Promise((r) => setTimeout(r, 3000));
      current = await getOrder(String(ORDER_ID));
      process.stdout.write(current.status === 'created' ? '.' : '\n');
    }
    if (current.status === 'created') {
      console.log(`\n⏳ 超时未支付（仍 pending）。订单 ${ORDER_ID} 保留，付款后重跑本命令即可：`);
      console.log(`   sudo node --env-file=.env scripts/buy-real-report.mjs --order-id=${ORDER_ID} --wait`);
      process.exit(3);
    }
    if (current.status !== 'paid' && current.status !== 'consumed') {
      console.error(`\n❌ 订单状态异常：${current.status}`);
      process.exit(1);
    }
    console.log(`\n✅ 已支付：${current.orderId}（¥${(current.amountFen / 100).toFixed(2)}，transaction=${current.transactionId || '—'}）`);

    // 支付成功后走真实生成接口（带 orderId → 消费订单）
    const token = signLocalToken(String(order.uid));
    const res = await fetch(`${BASE}/v1/report/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sku: order.sku, orderId: order.orderId, ...(order.sku === 'diagnose'
        ? { description: '扫码支付验证：我们认识三个月，他从不主动约我，最近两周已读不回超过 72 小时。', scenes: ['ambiguous'] }
        : order.sku === 'retro'
          ? { selfView: '我一直在追着这段关系跑，争执后总是我先去修。', partnerView: '他觉得我要求太多，只想活在当下。' }
          : { targetUid: String((await db.collection('users').findOne({ nickname: { $exists: true } }))?._id || '') }) }),
    });
    const json = await res.json().catch(() => ({}));
    const reportId = json?.data?.reportId || json?.reportId;
    if (!res.ok || !reportId) {
      console.error(`❌ 生成接口失败：HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
      process.exit(1);
    }
    console.log(`生成中：${reportId}`);
    let report = null;
    const genDeadline = Date.now() + 180_000;
    while (Date.now() < genDeadline) {
      const r = await fetch(`${BASE}/v1/report/${reportId}`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => ({}));
      report = j?.data || null;
      if (report?.status === 'ready' || report?.status === 'failed') break;
      await new Promise((r2) => setTimeout(r2, 4000));
    }
    const after = await getOrder(String(ORDER_ID));
    console.log(`\n报告状态：${report?.status} · 完整度 ${report?.completeness ?? '—'} · 订单 ${after?.status}`);
    console.log(`摘要：${String(report?.sections?.summary || report?.content || '').slice(0, 120)}…`);
    if (report?.status !== 'ready' || after?.status !== 'consumed') {
      console.error('❌ 支付成功但生成/消费未完成');
      process.exit(1);
    }
    console.log('✅ 扫码真付 → 生成报告 → 订单消费，全链路通过');
    process.exit(0);
  }

  /* ---------------- 第一段：建单 + 出二维码 ---------------- */
  // 账号需过 18+ 年龄门（三个付费入口都挂 requireAdult）
  await db.collection('users').updateOne(
    { _id: UID },
    {
      $set: {
        nickname: '扫码验证号',
        gender: 'female',
        birthYear: 1995,
        status: 'active',
        adultAgreedAt: new Date(),
        adultAgreementVer: ADULT_AGREEMENT_VER,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );
  await db.collection('auth_users').updateOne(
    { userId: UID },
    { $set: { userId: UID, clientId: 'real_pay', updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );

  const amountFen = await priceFenFor(UID, SKU);
  const order = await createOrder({ uid: UID, sku: SKU, amountFen, channel: 'native', meta: { realPay: true } });
  const prepay = await createNativeOrder({
    orderId: order.orderId,
    description: `Q问·${SKU}（扫码验证）`,
    amountFen,
    notifyUrl: process.env.WECHAT_PAY_NOTIFY_URL,
  });
  const codeUrl = prepay?.codeUrl;
  if (!codeUrl) {
    console.error('❌ 微信没返回 codeUrl，无法扫码：', JSON.stringify(prepay));
    process.exit(1);
  }

  // 用本地二维码实现（纯 JS）画 PNG：不依赖 canvas / sharp / pngjs，也不走任何境外服务
  // 两处来源：部署包里的 /opt/qtvq/js（bundle 会同步），以及静态站实际在用的
  // /var/www/qtvq/js。历史上 /opt/qtvq/js 曾长期停在一份 322 字节的旧 stub 上，
  // 所以这里显式校验导出是否存在，缺了立刻说清楚，而不是丢一个 "is not a function"。
  let qrMatrix = null;
  for (const candidate of [u('../../js/qr-render.js'), u('/var/www/qtvq/js/qr-render.js')]) {
    try {
      const mod = await import(candidate);
      if (typeof mod.qrMatrix === 'function') {
        qrMatrix = mod.qrMatrix;
        break;
      }
      console.error(`[qr] ${candidate} 里没有 qrMatrix 导出（旧副本？）`);
    } catch (err) {
      console.error(`[qr] 无法加载 ${candidate}：${err?.message || err}`);
    }
  }
  if (!qrMatrix) {
    console.error('❌ 找不到可用的 js/qr-render.js（需要其中的 qrMatrix）');
    process.exit(1);
  }
  const { qrPngBuffer } = await import('../src/lib/png-qr.js');
  const matrix = qrMatrix(codeUrl);
  const scale = 10;
  const quiet = 4;
  fs.writeFileSync(QR_OUT, qrPngBuffer(matrix, { scale, quiet }));
  fs.chmodSync(QR_OUT, 0o644);
  const px = (matrix.length + quiet * 2) * scale;
  console.log(`订单：${order.orderId}`);
  console.log(`商品：${SKU} · ¥${(amountFen / 100).toFixed(2)}（商户 ${getWechatPayConfig().mchId}）`);
  console.log(`二维码：${QR_OUT}（${px}×${px}，静区 ${quiet} 模块）`);
  console.log(`codeUrl：${codeUrl}`);

  if (NO_WAIT) {
    console.log(`\n下一步（手机扫上面那张图付款后）：`);
    console.log(`   sudo node --env-file=.env scripts/buy-real-report.mjs --order-id=${order.orderId} --wait`);
    process.exit(0);
  }

  // 没传 --no-wait 时直接进入等待（方便手工跑一条命令）
  console.log('\n等待支付…（Ctrl+C 可中断，订单保留）');
  const deadline = Date.now() + TIMEOUT_S * 1000;
  let current = order;
  while (Date.now() < deadline && current.status === 'created') {
    await new Promise((r) => setTimeout(r, 3000));
    current = await getOrder(order.orderId);
    process.stdout.write(current.status === 'created' ? '.' : '\n');
  }
  if (current.status === 'created') {
    console.log(`\n⏳ 超时未支付。付款后重跑：--order-id=${order.orderId} --wait`);
    process.exit(3);
  }
  // 这里不再重复生成逻辑：交回给自己（--wait 分支）
  console.log(`\n已支付，继续生成：`);
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['--env-file=.env', 'scripts/buy-real-report.mjs', `--order-id=${order.orderId}`, '--wait'], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  process.exit(r.status ?? 1);
}

main().catch((err) => {
  console.error('❌ 出错：', err?.stack || err?.message || err);
  process.exit(1);
});
