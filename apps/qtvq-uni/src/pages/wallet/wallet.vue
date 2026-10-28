<template>
  <view class="page">
    <view class="card">
      <text class="title">缘值钱包</text>
      <view class="balance-row">
        <text class="balance">{{ balance.toFixed(2) }}</text>
        <text class="balance-unit">元</text>
      </view>
      <text class="hint">
        缘值用于「转盘 · 每次 ¥1」与「配对报告按次扣费」。
        会员费（月/季/年卡）买的是权益，<text class="strong">不会增加缘值</text>，两笔钱互不通用。
      </text>
      <text v-if="memberText" class="member">{{ memberText }}</text>
    </view>

    <!-- iOS 端：整块充值区不出现，只留说明（E.44，微信审核硬项） -->
    <view v-if="payBlocked" class="card">
      <text class="section-title">iOS 端暂不支持充值</text>
      <text class="hint">{{ payBlockedTip }}</text>
    </view>

    <!-- ── 充值：金额自定，付款成功自动到账（不用人工核实） ── -->
    <view v-if="!payBlocked" class="card recharge">
      <text class="section-title">缘值充值（微信在线支付 · 自动到账）</text>
      <text class="hint">¥1 – ¥2000，可填两位小数。付款成功后缘值自动加上，不需要联系客服。</text>

      <view class="presets">
        <view
          v-for="p in presets"
          :key="p"
          :class="['preset', String(amount) === String(p) ? 'active' : '']"
          @tap="pickPreset(p)"
        >
          <text>¥{{ p }}</text>
        </view>
      </view>

      <view class="amount-row">
        <text class="yuan">¥</text>
        <input v-model="amount" class="amount-input" type="digit" placeholder="自定义金额" />
      </view>

      <button class="btn-primary" :disabled="creating" @tap="startPay">
        {{ creating ? '正在创建订单…' : `微信支付 ¥${amountText}` }}
      </button>
      <text v-if="payMsg" :class="['pay-msg', payPaid ? 'ok' : '']">{{ payMsg }}</text>
      <text class="hint">充值的钱只进缘值，不会开通会员；开通会员请到「办理会员」页。</text>
    </view>

    <view class="card" v-if="tiers.length">
      <text class="section-title">各档位对我会收多少</text>
      <view v-for="t in tiers" :key="t.key" class="tier-item">
        <text class="tier-zh">{{ t.zh }}</text>
        <text class="tier-price">{{ t.price > 0 ? '¥' + t.price : '免费' }}</text>
      </view>
      <text class="hint">会员每日有免费次数，详见「办理会员」页。</text>
    </view>

    <view class="card">
      <text class="section-title">流水（最近 {{ ledger.length }} 笔）</text>
      <view v-if="ledger.length === 0"><text class="hint">还没有流水记录</text></view>
      <view v-for="(l, i) in ledger" :key="i" class="ledger-item">
        <view class="ledger-main">
          <text class="ledger-reason">{{ reasonText(l.reason, l.ref) }}</text>
          <text class="ledger-time">{{ formatTime(l.createdAt) }}<text v-if="l.ref"> · {{ l.ref }}</text></text>
        </view>
        <view class="ledger-right">
          <text :class="['ledger-amount', l.amount > 0 ? 'in' : 'out']">
            {{ l.amount > 0 ? '+' : '' }}{{ Number(l.amount || 0).toFixed(2) }}
          </text>
          <text v-if="typeof l.balanceAfter === 'number'" class="ledger-balance">余 {{ Number(l.balanceAfter).toFixed(2) }}</text>
        </view>
      </view>
    </view>

    <text v-if="errorText" class="error">{{ errorText }}</text>

    <!-- 二维码本地绘制的画布：移出可视区，仅用于生成图片 -->
    <canvas canvas-id="walletQrCanvas" id="walletQrCanvas" class="qr-canvas" />

    <!-- 扫码支付弹层：与会员页同一形态，含订单号、状态与关闭按钮 -->
    <view v-if="viewerOpen" class="pay-viewer" @click="closeViewer">
      <view class="pay-viewer-box" @click.stop>
        <text class="pay-viewer-title">微信在线支付 · 缘值充值</text>
        <text class="pay-viewer-amount">应付金额：¥{{ amountText }}</text>
        <text v-if="viewerOrderId" class="pay-viewer-order">订单号：{{ viewerOrderId }}</text>
        <text :class="['pay-viewer-status', payPaid ? 'is-paid' : '']">{{ payMsg || '等待支付中…' }}</text>
        <image
          v-if="viewerImage"
          class="pay-viewer-img"
          :src="viewerImage"
          mode="widthFix"
          show-menu-by-longpress
          @click="previewImage"
        />
        <text class="pay-viewer-tip">请用微信扫一扫；支付成功后缘值自动到账，本页会自己刷新。</text>
        <view class="pay-viewer-actions">
          <button class="btn-secondary btn-sm" @click="closeViewer">关闭</button>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onUnmounted } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { fetchWallet, fetchWalletLedger } from '../../api/wallet.js';
import { createTopupOrder, pollWechatPayOrder } from '../../api/payment-wechat.js';
import { wechatLoginCode } from '../../api/auth.js';
import { getAuthUser } from '../../utils/auth.js';
import { qrMatrix, drawQrToCanvas } from '../../utils/qr-render.js';
import { isVirtualPayBlocked, VIRTUAL_PAY_BLOCKED_TIP } from '../../utils/platform.js';

/**
 * iOS 微信小程序内不能买虚拟商品（缘值就是虚拟商品），整块充值区隐藏。
 * 与会员页同一口径，说明文案也读同一个常量（见 utils/platform.js）。
 */
const payBlocked = isVirtualPayBlocked();
const payBlockedTip = VIRTUAL_PAY_BLOCKED_TIP;

const balance = ref(0);
const tiers = ref([]);
const ledger = ref([]);
const membership = ref(null);
const errorText = ref('');

const presets = [10, 30, 50, 100];
const amount = ref('10');
const creating = ref(false);
const payMsg = ref('');
const payPaid = ref(false);
const viewerOpen = ref(false);
const viewerImage = ref('');
const viewerOrderId = ref('');
let stopPoll = null;

const amountText = computed(() => {
  const n = Number(amount.value);
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : '0.00';
});

const memberText = computed(() => {
  const m = membership.value;
  if (!m) return '';
  if (m.active && m.activeUntil) {
    return `会员有效 · 到期 ${new Date(m.activeUntil).toLocaleDateString('zh-CN')}`;
  }
  return '当前不是会员（会员每日有免费转盘/报告次数）';
});

/**
 * 流水原因的中文说明（与后端 reason 枚举对应）
 *
 * 注意 admin_credit 那一行：2026-09-18 之前，Node 侧把**在线充值**的流水 reason 也写成了
 * 'admin_credit'，于是用户在缘值明细里看到的是「人工入账」——"我明明在线付的"。
 * 服务端已改成在线充值写 'topup'，但**历史记录改不了**，所以这里对
 * "reason=admin_credit 且 ref 是 ord_ 开头的订单号"这条明确特征显示为在线充值。
 * 这是显示层的兜底，不是猜测：ref 为订单号只可能来自在线支付自动入账那条路径。
 */
function reasonText(reason, ref) {
  const map = {
    wheel_spin: '转盘',
    member_daily_spin: '转盘（会员每日免费）',
    report_charge: '配对报告',
    member_daily_free: '配对报告（会员每日免费）',
    free_tier: '配对报告（体验档免费）',
    admin_credit: '人工入账',
    refund: '退款回冲',
    topup: '缘值充值',
    billing_disabled: '计费未开启',
  };
  if (reason === 'admin_credit' && typeof ref === 'string' && ref.startsWith('ord_')) {
    return '缘值充值（在线支付）';
  }
  return map[reason] || reason || '—';
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function load() {
  errorText.value = '';
  try {
    const w = await fetchWallet();
    const wallet = w.wallet || w;
    balance.value = Number(wallet.balance || 0);
    membership.value = wallet.membership || w.membership || null;
    const t = w.tiers || wallet.tiers;
    if (Array.isArray(t)) tiers.value = t;
  } catch (e) {
    errorText.value = e?.statusCode === 401 ? '登录后可查看缘值与流水' : e?.message || '加载失败';
    return;
  }
  try {
    const l = await fetchWalletLedger(50);
    ledger.value = l.items || [];
  } catch {
    ledger.value = [];
  }
}

function pickPreset(p) {
  amount.value = String(p);
}

/** 校验金额：与服务端 validateTopupAmount 一致（¥1–2000，最多两位小数） */
function validateAmount() {
  const n = Number(amount.value);
  if (!Number.isFinite(n) || n < 1 || n > 2000) {
    uni.showToast({ title: '充值金额需在 ¥1 – ¥2000 之间', icon: 'none' });
    return null;
  }
  if (Math.round(n * 100) !== Number((n * 100).toFixed(0))) {
    uni.showToast({ title: '金额最多两位小数', icon: 'none' });
    return null;
  }
  return Number(n.toFixed(2));
}

/** 把订单码画到隐藏 canvas 并导出临时图片路径（小程序没有 DOM canvas） */
function drawOrderQr(codeUrl, size = 280) {
  return new Promise((resolve, reject) => {
    let matrix;
    try {
      matrix = qrMatrix(codeUrl);
    } catch (e) {
      reject(e);
      return;
    }
    const ctx = uni.createCanvasContext('walletQrCanvas');
    drawQrToCanvas(ctx, matrix, size);
    ctx.draw(false, () => {
      uni.canvasToTempFilePath(
        {
          canvasId: 'walletQrCanvas',
          x: 0,
          y: 0,
          width: size,
          height: size,
          destWidth: size * 2,
          destHeight: size * 2,
          success: (res) => resolve(res.tempFilePath),
          fail: (err) => reject(new Error(err?.errMsg || '二维码导出失败')),
        },
      );
    });
  });
}

function stopPolling() {
  if (stopPoll) {
    stopPoll();
    stopPoll = null;
  }
}

function closeViewer() {
  stopPolling();
  viewerOpen.value = false;
}

function previewImage() {
  if (!viewerImage.value) return;
  uni.previewImage({ urls: [viewerImage.value] });
}

/** 充值成功后的统一收尾：刷新钱包与流水 */
async function onPaid() {
  payPaid.value = true;
  payMsg.value = `✓ 支付成功，¥${amountText.value} 已请求入账（以缘值明细为准）`;
  // ⚠️ 付款成功 ≠ 已入账。这里原来直接弹「充值成功」，而它的依据只是**订单状态变成 paid**
  // （订单是被 payment-activate.js 的 markOrderPaid() 先标成 paid 的，与钱是否进钱包无关）。
  // 2026-10-11 事故里入账失败、界面却报成功。改为如实提示，让用户以缘值明细为准。
  uni.showToast({ title: '支付成功，入账以缘值明细为准', icon: 'none' });
  stopPolling();
  await load();
}

/** 只建一单扫码支付（用户确认后才调用，避免"扣款失败自动再建一单"留下两个 pending 订单） */
async function startQrPay(value, uid) {
  const nativeData = await createTopupOrder(value, 'native', { uid });
  if (!nativeData?.codeUrl) {
    throw new Error(nativeData?.error || nativeData?.message || '未获取到二维码，请重试');
  }
  viewerOrderId.value = nativeData.orderId || '';
  viewerOpen.value = true;
  payMsg.value = `订单 ${nativeData.orderId || ''} · 等待支付中…`;
  try {
    viewerImage.value = await drawOrderQr(nativeData.codeUrl);
  } catch {
    payMsg.value = '二维码生成失败，请重试';
  }
  if (nativeData.orderId) {
    stopPoll = pollWechatPayOrder(nativeData.orderId, { onPaid: () => onPaid() });
  }
}

/** JSAPI 扣款没走通时，问用户要不要改用扫码 —— 而不是默默再建一单 */
function offerQrPay(value, uid, content) {
  uni.showModal({
    title: '改用扫码支付？',
    content,
    confirmText: '扫码支付',
    cancelText: '知道了',
    success: (res) => {
      if (res.confirm) startQrPay(value, uid).catch((e) => showErr(e));
    },
  });
}

function showErr(e) {
  payMsg.value = e?.message || '创建充值订单失败';
  uni.showToast({ title: payMsg.value, icon: 'none' });
}

async function startPay() {
  // 双保险（模板已 v-if 掉充值区）：合规开关在模板与逻辑各挡一次
  if (payBlocked) {
    uni.showModal({ title: 'iOS 端暂不支持', content: payBlockedTip, showCancel: false });
    return;
  }
  const value = validateAmount();
  if (value === null) return;
  const user = getAuthUser();
  // 缘值充值必须能定位到账号：服务端 createTopupOrder 缺少 uid 会直接拒绝
  // （"请先登录后再充值（需要账号才能入账）"），所以这里先按同一口径拦住。
  if (!user?.id) {
    uni.showToast({ title: '请先登录后再充值（需要账号才能入账）', icon: 'none' });
    return;
  }
  const uid = user.id;

  creating.value = true;
  payMsg.value = '';
  payPaid.value = false;
  viewerImage.value = '';
  viewerOrderId.value = '';
  try {
    // #ifdef MP-WEIXIN
    // 小程序内首选直接扣款（JSAPI）——**成功建单才继续**；
    // 建单失败（含 code 换 openid 失败）时服务端不会留下订单，这时只是提示改用扫码，
    // 由用户点确认后才建扫码那一单，保证"一次点击最多一个订单"。
    let jsapiData = null;
    let jsapiErr = null;
    try {
      const code = await wechatLoginCode();
      jsapiData = await createTopupOrder(value, 'jsapi', { code, uid });
    } catch (e) {
      jsapiErr = e;
    }

    if (jsapiData?.jsapi) {
      viewerOpen.value = true;
      viewerOrderId.value = jsapiData.orderId || '';
      payMsg.value = '请在微信支付窗口完成付款…';
      if (jsapiData.orderId) {
        stopPoll = pollWechatPayOrder(jsapiData.orderId, { onPaid: () => onPaid() });
      }
      uni.requestPayment({
        provider: 'wxpay',
        timeStamp: jsapiData.jsapi.timeStamp,
        nonceStr: jsapiData.jsapi.nonceStr,
        package: jsapiData.jsapi.package,
        signType: jsapiData.jsapi.signType || 'RSA',
        paySign: jsapiData.jsapi.paySign,
        success: () => {
          payMsg.value = '支付完成，正在确认到账…';
        },
        fail: (err) => {
          const cancelled = err?.errMsg?.includes('cancel');
          payMsg.value = cancelled ? '已取消支付' : '扣款未完成';
          offerQrPay(
            value,
            uid,
            cancelled ? '你已取消微信支付。要改用二维码支付吗？' : '本次扣款未完成。要改用二维码支付吗？',
          );
        },
      });
      return;
    }

    // 没有拿到 jsapi 参数：可能是未配置（stub）或服务端拒绝
    const reason = jsapiData?.message || jsapiErr?.message || '微信直接扣款暂不可用';
    payMsg.value = reason;
    offerQrPay(value, uid, `${reason}。要改用二维码支付吗？`);
    // #endif

    // #ifndef MP-WEIXIN
    await startQrPay(value, uid);
    // #endif
  } catch (e) {
    showErr(e);
  } finally {
    creating.value = false;
  }
}

onShow(() => {
  if (!viewerOpen.value) load();
});

onUnmounted(stopPolling);
</script>

<style lang="scss">
.page { padding: 24rpx; background: $color-bg-deep; min-height: 100vh; }
.card { background: $color-bg-sunken; border-radius: 16rpx; padding: 24rpx; margin-bottom: 24rpx; }
.title { font-size: 34rpx; font-weight: 600; color: #fff; display: block; }
.section-title { font-size: 28rpx; color: #fff; display: block; margin-bottom: 12rpx; }
.balance-row { display: flex; align-items: baseline; gap: 8rpx; margin: 12rpx 0; }
.balance { font-size: 64rpx; color: $color-pink; font-weight: 700; }
.balance-unit { font-size: 26rpx; color: $color-text-dim; }
.hint { font-size: 24rpx; color: $color-text-dim; display: block; line-height: 1.7; margin: 8rpx 0; }
.strong { color: $color-pink-soft; }
.member { font-size: 24rpx; color: $color-warning; display: block; margin: 8rpx 0 16rpx; }
.btn-primary { background: $color-pink; color: #fff; border-radius: 999rpx; margin-top: 12rpx; }
.recharge { border: 2rpx solid rgba(255,107,129,0.35); }
.presets { display: flex; gap: 12rpx; margin: 16rpx 0; }
.preset { flex: 1; text-align: center; padding: 16rpx 0; border-radius: 12rpx; border: 2rpx solid rgba(255,255,255,0.12); color: $color-text-softer; font-size: 26rpx; }
.preset.active { border-color: $color-pink; background: rgba(255,107,129,0.14); color: $color-pink-soft; }
.amount-row { display: flex; align-items: center; gap: 10rpx; margin-bottom: 8rpx; }
.yuan { font-size: 32rpx; color: $color-pink-soft; }
.amount-input { flex: 1; height: 88rpx; line-height: 88rpx; background: $color-bg-deep; border: 1rpx solid rgba(255,255,255,0.12); border-radius: 12rpx; padding: 0 20rpx; color: #fff; font-size: 30rpx; }
.pay-msg { font-size: 24rpx; color: $color-pink-soft; display: block; margin-top: 12rpx; line-height: 1.6; }
.pay-msg.ok { color: $color-success-soft; }
.tier-item { display: flex; justify-content: space-between; padding: 14rpx 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
.tier-zh { font-size: 26rpx; color: $color-text-bright; }
.tier-price { font-size: 26rpx; color: $color-pink-soft; }
.ledger-item { display: flex; justify-content: space-between; align-items: center; padding: 16rpx 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
.ledger-reason { font-size: 26rpx; color: $color-text-bright; display: block; }
.ledger-time { font-size: 22rpx; color: $color-text-dim; }
.ledger-right { text-align: right; }
.ledger-amount { font-size: 28rpx; display: block; }
.ledger-amount.in { color: $color-success-soft; }
.ledger-amount.out { color: $color-danger-soft; }
.ledger-balance { font-size: 22rpx; color: $color-text-dim; }
.error { color: $color-danger-soft; font-size: 24rpx; display: block; padding: 0 8rpx; }
.qr-canvas { position: fixed; left: -9999px; top: 0; width: 280px; height: 280px; }
.pay-viewer { position: fixed; inset: 0; z-index: 999; background: rgba(0,0,0,0.72); display: flex; align-items: center; justify-content: center; padding: 32rpx; }
.pay-viewer-box { width: 100%; max-width: 640rpx; background: $color-bg-card-alt; border-radius: 24rpx; padding: 32rpx; border: 1rpx solid rgba(108,92,231,0.45); }
.pay-viewer-title { display: block; font-size: 32rpx; font-weight: 700; color: $color-pink-light; }
.pay-viewer-amount { display: block; font-size: 30rpx; color: $color-pink; font-weight: 700; margin-top: 16rpx; }
.pay-viewer-order { display: block; font-size: 22rpx; color: $color-text-muted; margin-top: 12rpx; word-break: break-all; }
.pay-viewer-status { display: block; text-align: center; font-size: 24rpx; color: $color-pink-light; margin-top: 12rpx; }
.pay-viewer-status.is-paid { color: $color-success-bright; }
.pay-viewer-img { width: 100%; margin-top: 20rpx; border-radius: 12rpx; background: #fff; }
.pay-viewer-tip { display: block; font-size: 22rpx; color: $color-text-muted; margin-top: 16rpx; line-height: 1.5; }
.pay-viewer-actions { display: flex; gap: 12rpx; margin-top: 24rpx; }
.btn-secondary { background: $color-bg-raised; color: $color-text-softer; border-radius: 999rpx; }
.btn-sm { flex: 1; font-size: 24rpx; padding: 16rpx 8rpx; }
</style>
