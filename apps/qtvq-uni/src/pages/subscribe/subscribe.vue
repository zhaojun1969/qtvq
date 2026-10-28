<template>
  <view class="page">
    <view class="card">
      <text class="title">办理 Q问 会员</text>
      <text class="hint">免费用户每 24 小时 5 次新提问；会员核实后不限次。</text>
    </view>

    <view class="plans card">
      <view
        v-for="p in plans"
        :key="p.id"
        :class="['plan', selected === p.id ? 'plan-active' : '']"
        @click="selectPlan(p.id)"
      >
        <text class="plan-label">{{ p.label }}</text>
        <text class="plan-price">¥{{ p.price }}</text>
      </view>
    </view>

    <!--
      iOS 端整块付费区替换成说明（E.44 · 微信审核硬项）。

      不是"少一个按钮"：微信禁的是**在 iOS 小程序内完成虚拟商品交易**，
      把直接扣款换成静态收款码属于同一条违规的另一种写法。
      所以这里 v-if 掉整块付费区，只留说明 + 去网页版的出口。
    -->
    <view v-if="payBlocked" class="card pay-blocked-card">
      <text class="section-title">iOS 端暂不支持购买</text>
      <text class="hint pay-hint form-readable">{{ payBlockedTip }}</text>
      <button class="btn-secondary btn-block btn-outline" @tap="copyBuyUrl">复制网页版地址</button>
    </view>

    <view v-if="!payBlocked" class="card pay-online-card">
      <!-- 动态在线支付卡。
           2026-10-11 修正：这里原来只写 `#ifdef MP-WEIXIN`，于是 **H5 与桌面壳的会员页整张卡被剪掉**，
           桌面端只剩静态收款码 —— 用户付了钱不会自动到账、系统里也查不到记录（业务方实测两次）。
           H5/App 与网页端一样有能力走"下单 → 二维码 → 轮询自动到账"，所以放宽到这三个平台。
           JSAPI（直接扣款）只有微信小程序能做，用**运行时判断** canJsapi 门控而不是嵌套 ifdef ——
           uni-app **不支持嵌套条件编译**：先前在外层 ifdef 里嵌套了一层 MP-WEIXIN，内层被静默忽略，
           结果 H5/桌面端也渲染了它，而它调用 uni.login/uni.requestPayment 在 H5 上必然失败。 -->
      <!-- #ifdef MP-WEIXIN || H5 || APP-PLUS -->
      <text class="section-title">微信在线支付（自动到账）</text>
      <text class="hint pay-hint form-readable">支付成功后自动开通，无需人工核实。</text>
      <button v-if="canJsapi" class="btn-primary btn-block" :disabled="onlineLoading" @click="startWalletPay">
        {{ onlineLoading ? '创建订单中…' : `微信支付 ¥${selectedPrice}（直接扣款）` }}
      </button>
      <button class="btn-secondary btn-block btn-outline" :disabled="onlineLoading" @click="startQrPay">
        扫码支付（二维码，可选）
      </button>
      <!-- #endif -->
      <!-- #ifndef MP-WEIXIN || H5 || APP-PLUS -->
      <text class="section-title">办理会员</text>
      <text class="hint pay-hint form-readable">
        界面与微信小程序一致：请使用下方静态收款码或对公汇款，提交核实后开通（月卡 ¥29 / 季卡 ¥79 / 年卡 ¥299）。
      </text>
      <!-- #endif -->
    </view>

    <view v-if="!payBlocked" class="card">
      <text class="section-title">静态收款码 · 点击放大</text>
      <text class="hint pay-hint">或使用下方收款码；需手填 ¥{{ selectedPrice }} 与设备编号并提交核实。</text>
      <view class="pay-grid">
        <view
          v-for="ch in payChannels"
          :key="ch.id"
          class="pay-card"
          @click="openPayViewer(ch)"
        >
          <image class="pay-thumb" :src="ch.image" mode="aspectFit" />
          <text class="pay-label">{{ ch.label }}</text>
        </view>
      </view>
    </view>

    <view v-if="company && !payBlocked" class="card">
      <text class="section-title">对公银行汇款</text>
      <text class="bank-line">户名：{{ company.name }}</text>
      <text class="bank-line">账号：{{ company.cardNo }}</text>
      <text class="bank-line">开户行：{{ company.bank }}</text>
      <text class="bank-line">备注建议填设备编号</text>
      <button class="btn-secondary btn-block" @click="copyBank">复制账号</button>
    </view>

    <view v-if="!payBlocked" id="payment-form" class="card form-card">
      <text class="section-title form-section-title">提交汇款核实</text>
      <text class="hint pay-hint form-readable">扫码或对公汇款后填写以下信息，便于核对开通会员。</text>
      <text class="form-label">汇款人姓名</text>
      <input v-model="form.payerName" class="field field-lg" placeholder="请填写汇款人姓名" />
      <text class="form-label">汇款金额（元）</text>
      <input v-model="form.amount" class="field field-lg" type="digit" placeholder="请按所选套餐金额填写" />
      <text class="form-label">备注 / 设备编号</text>
      <input v-model="form.remark" class="field field-lg" placeholder="建议填写设备编号" />
      <button class="btn-primary btn-block btn-lg" :disabled="submitting" @click="submit">
        {{ submitting ? '提交中…' : '我已汇款，提交核实' }}
      </button>
    </view>

    <text v-if="!payBlocked" class="legal legal-lg">收款方：我心永恒（北京）网络科技有限公司。核实到账后开通会员。</text>

    <!--
      下单前的协议可见入口（电子商务法要求"下单前可使消费者知悉协议"）。
      iOS 端也保留：那一端虽然不能买，用户仍然要知道自己用的是什么规则。
    -->
    <view class="legal-links">
      <text class="legal-link" @tap="openDoc('terms')">《用户协议》</text>
      <text class="legal-link" @tap="openDoc('privacy')">《隐私政策》</text>
    </view>

    <view v-if="viewerOpen" class="pay-viewer" @click="closePayViewer">
      <view class="pay-viewer-box" @click.stop>
        <text class="pay-viewer-title">{{ viewerTitle }}</text>
        <text class="pay-viewer-amount">应付金额：¥{{ selectedPrice }}</text>
        <view v-if="viewerMode === 'static'" class="pay-viewer-client">
          <text class="client-text">设备编号（建议写入备注）：{{ clientId }}</text>
          <button class="btn-mini" @click="copyClientId">复制</button>
        </view>
        <text v-if="viewerOrderId" class="pay-viewer-order">订单号：{{ viewerOrderId }}</text>
        <text v-if="viewerStatus" :class="['pay-viewer-status', viewerPaid ? 'is-paid' : '']">{{ viewerStatus }}</text>
        <image
          v-if="viewerImage"
          class="pay-viewer-img"
          :src="viewerImage"
          mode="widthFix"
          show-menu-by-longpress
          @click="previewViewerImage"
        />
        <!-- 二维码本地绘制的画布：位置移出可视区，仅用于生成图片 -->
        <canvas
          canvas-id="payQrCanvas"
          id="payQrCanvas"
          class="pay-qr-canvas"
        />
        <text class="pay-viewer-tip">{{ viewerTip }}</text>
        <view class="pay-viewer-actions">
          <button class="btn-secondary btn-sm" @click="closePayViewer">关闭</button>
          <button v-if="viewerMode === 'static'" class="btn-secondary btn-sm" @click="copyAmount">复制金额</button>
          <button v-if="viewerMode === 'static'" class="btn-primary btn-sm" @click="payDone">我已完成支付</button>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { PLANS, WEB_BASE } from '../../data/constants.js';
import { PAY_CHANNELS, channelTip } from '../../data/pay-channels.js';
import { fetchPaymentInfo, submitPayment } from '../../api/quota.js';
import { createWechatPayOrder, pollWechatPayOrder } from '../../api/payment-wechat.js';
import { wechatLoginCode } from '../../api/auth.js';
import { qrMatrix, drawQrToCanvas } from '../../utils/qr-render.js';
// JSAPI（直接扣款）只有微信小程序可用 —— 用运行时判断给按钮做门控（见模板里的说明）
import { supportsWechatJsapiPay, isVirtualPayBlocked, VIRTUAL_PAY_BLOCKED_TIP } from '../../utils/platform.js';

/**
 * 把订单码画到隐藏 canvas 并导出临时图片路径。
 * 小程序没有 DOM canvas，必须走 canvas → canvasToTempFilePath 这条路；
 * 导出后仍用 <image :src> 显示，页面其它逻辑无需改动。
 */
function drawOrderQr(codeUrl, size = 280) {
  return new Promise((resolve, reject) => {
    let matrix;
    try {
      matrix = qrMatrix(codeUrl);
    } catch (e) {
      reject(e);
      return;
    }
    const ctx = uni.createCanvasContext('payQrCanvas');
    drawQrToCanvas(ctx, matrix, size);
    ctx.draw(false, () => {
      uni.canvasToTempFilePath(
        {
          canvasId: 'payQrCanvas',
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

import { getClientId } from '../../utils/clientId.js';
import { track } from '../../utils/track.js';

const plans = PLANS;
const payChannels = PAY_CHANNELS;
/** 能否走"直接扣款"（JSAPI）：仅微信小程序**且非 iOS** 为 true；H5/App/其它小程序/iOS 为 false */
const canJsapi = supportsWechatJsapiPay();
/**
 * 是否整块禁用付费（当前只有 iOS 微信小程序）。
 * 与 canJsapi 分开：canJsapi 只关掉"直接扣款"这一个按钮，
 * payBlocked 关掉整个付费区（含静态码、对公汇款、提交核实表单）。
 */
const payBlocked = isVirtualPayBlocked();
const payBlockedTip = VIRTUAL_PAY_BLOCKED_TIP;
const selected = ref('month');
const company = ref(null);
const submitting = ref(false);
const onlineLoading = ref(false);
const viewerOpen = ref(false);
const viewerMode = ref('static');
const viewerTitle = ref('');
const viewerTip = ref('');
const viewerImage = ref('');
const viewerOrderId = ref('');
const viewerStatus = ref('');
const viewerPaid = ref(false);
const clientId = ref('');
const form = ref({ payerName: '', amount: '', remark: '' });
let stopPoll = null;

/**
 * 会员开通成功的埋点出口。
 *
 * 会员单同样落在服务端 `orders` 集合，营收/付费用户**只认 `orders`**；
 * `membership_purchase` 只表示「客户端看到一次开通成功」，与看板不叠加。
 * 按订单号去重：扫码与直接扣款是两条独立轮询，同一单不能记两次。
 */
const paidTracked = new Set();
function trackMembershipPaid(orderId, via) {
  const key = orderId || `no-order:${selected.value}`;
  if (paidTracked.has(key)) return;
  paidTracked.add(key);
  try {
    track('membership_purchase', {
      plan: selected.value,
      price: selectedPrice.value,
      via,
      orderId,
    });
  } catch {
    /* 埋点永不打断主流程 */
  }
}

const selectedPrice = computed(() => plans.find((p) => p.id === selected.value)?.price || 29);

function selectPlan(id) {
  selected.value = id;
  form.value.amount = String(selectedPrice.value);
}

function openPayViewer(ch) {
  stopPolling();
  viewerMode.value = 'static';
  viewerTitle.value = `${ch.label} · 扫码付款`;
  viewerTip.value = channelTip(ch.id, selectedPrice.value);
  viewerImage.value = ch.image;
  viewerOrderId.value = '';
  viewerStatus.value = '';
  viewerPaid.value = false;
  viewerOpen.value = true;
}

function openOnlineViewer(data, mode = 'qr') {
  stopPolling();
  viewerMode.value = 'online';
  viewerOrderId.value = data.orderId || '';
  viewerPaid.value = false;

  if (data.stub && !data.codeUrl && !data.jsapi) {
    viewerTitle.value = '微信在线支付 · 暂未开通';
    viewerTip.value = data.message || '商户 API 未配置，请使用静态收款码或银行汇款。';
    viewerImage.value = '';
    viewerStatus.value = '';
    viewerOpen.value = true;
    return;
  }

  if (mode === 'wallet' && data.jsapi) {
    invokeMiniProgramPay(data.jsapi, data.orderId);
    return;
  }

  viewerTitle.value = '微信在线支付 · 扫码付款';
  viewerTip.value = '请用微信扫一扫；支付成功后自动开通会员。';
  viewerStatus.value = data.codeUrl ? '等待支付中…' : '未获取到二维码，请重试或改用直接扣款';
  viewerOpen.value = true;
  // 二维码改为**本地绘制**：小程序不能像网页那样把订单码交给境外图片服务（国内加载不出来，
  // 而且小程序对境外域名有额外限制）。这里画到隐藏 canvas 再导出临时图片，
  // 后面的 <image :src> 与预览逻辑完全不用改。
  viewerImage.value = '';
  if (data.codeUrl) {
    drawOrderQr(data.codeUrl)
      .then((path) => {
        if (path) viewerImage.value = path;
      })
      .catch(() => {
        viewerStatus.value = '二维码生成失败，请重试';
      });
  }

  if (data.orderId) {
    stopPoll = pollWechatPayOrder(data.orderId, {
      onPaid: () => {
        viewerStatus.value = '✓ 支付成功，会员已开通';
        viewerPaid.value = true;
        uni.showToast({ title: '会员已开通', icon: 'success' });
        trackMembershipPaid(data.orderId, 'qr');
      },
    });
  }
}

function invokeMiniProgramPay(jsapi, orderId) {
  if (orderId) {
    stopPoll = pollWechatPayOrder(orderId, {
      onPaid: () => {
        uni.showToast({ title: '会员已开通', icon: 'success' });
        trackMembershipPaid(orderId, 'jsapi');
      },
    });
  }
  uni.requestPayment({
    provider: 'wxpay',
    timeStamp: jsapi.timeStamp,
    nonceStr: jsapi.nonceStr,
    package: jsapi.package,
    signType: jsapi.signType || 'RSA',
    paySign: jsapi.paySign,
    success: () => {
      uni.showToast({ title: '支付成功', icon: 'success' });
    },
    fail: (err) => {
      const cancelled = err?.errMsg?.includes('cancel');
      uni.showModal({
        title: cancelled ? '已取消支付' : '支付未完成',
        content: cancelled ? '您可点「扫码支付」改用二维码，或稍后再试。' : '请重试直接扣款，或改用扫码支付。',
        confirmText: '扫码支付',
        cancelText: '知道了',
        success: (res) => {
          if (res.confirm) startQrPay();
        },
      });
    },
  });
}

function stopPolling() {
  if (stopPoll) {
    stopPoll();
    stopPoll = null;
  }
}

function closePayViewer() {
  stopPolling();
  viewerOpen.value = false;
}

function previewViewerImage() {
  if (!viewerImage.value) return;
  uni.previewImage({ urls: [viewerImage.value] });
}

async function startWalletPay() {
  // 双保险：模板已 v-if 掉按钮，这里再挡一次 —— 以后谁把 v-if 改坏了，
  // 也不至于在 iOS 上真的调起支付（模板与逻辑各挡一次，是这类"合规开关"的固定写法）。
  if (payBlocked) {
    uni.showModal({ title: 'iOS 端暂不支持', content: payBlockedTip, showCancel: false });
    return;
  }
  onlineLoading.value = true;
  try {
    const code = await wechatLoginCode();
    const data = await createWechatPayOrder(selected.value, 'jsapi', { code });
    if (data.stub && !data.jsapi) {
      uni.showToast({ title: data.message || '在线支付未配置', icon: 'none' });
      openOnlineViewer(data, 'qr');
      return;
    }
    openOnlineViewer(data, 'wallet');
  } catch (e) {
    uni.showToast({ title: e.message || '创建订单失败', icon: 'none' });
  } finally {
    onlineLoading.value = false;
  }
}

async function startQrPay() {
  if (payBlocked) {
    uni.showModal({ title: 'iOS 端暂不支持', content: payBlockedTip, showCancel: false });
    return;
  }
  onlineLoading.value = true;
  try {
    const data = await createWechatPayOrder(selected.value, 'native');
    if (data.stub && !data.codeUrl) {
      uni.showToast({ title: data.message || '在线支付未配置', icon: 'none' });
    }
    openOnlineViewer(data, 'qr');
  } catch (e) {
    uni.showToast({ title: e.message || '创建订单失败', icon: 'none' });
  } finally {
    onlineLoading.value = false;
  }
}

function copyText(text, toast) {
  uni.setClipboardData({
    data: text,
    success: () => uni.showToast({ title: toast, icon: 'none' }),
  });
}

function copyClientId() {
  copyText(clientId.value, '已复制设备编号');
}

function copyAmount() {
  copyText(String(selectedPrice.value), `已复制金额 ¥${selectedPrice.value}`);
}

function copyBank() {
  if (!company.value?.cardNo) return;
  copyText(company.value.cardNo, '已复制账号');
}

/**
 * iOS 端复制网页版地址。
 *
 * 为什么给"复制"而不是"打开 web-view"：小程序 web-view 打开自家 H5 的会员页，
 * 会在页面里呈现完整的购买流程 —— 那等于绕开 iOS 限制，审核同样不认。
 * 复制地址让用户自己去浏览器打开，是微信规则下最干净的做法。
 */
function copyBuyUrl() {
  // 指向 account.html 而不是某个"会员页"：官网的办理/续费入口就在账户页（#btn-subscribe），
  // 用户复制过去落地即登录 + 付费两个动作在同一页，不用再找一次。
  copyText(`${WEB_BASE}/account.html`, '地址已复制，请在浏览器中打开');
}

/**
 * 打开协议页（terms / privacy）。
 *
 * 走 web-view 而不是把协议文本塞进小程序：协议会持续修订，塞进来就要为每次修订
 * 重新提审一遍小程序；指向官网页面则改完即可生效。标题用中文（见 DOC_TITLES）。
 */
const DOC_TITLES = { terms: '用户协议', privacy: '隐私政策' };
function openDoc(name) {
  const url = `${WEB_BASE}/${name}.html`;
  uni.navigateTo({
    url: `/pages/webview/webview?url=${encodeURIComponent(url)}&title=${encodeURIComponent(DOC_TITLES[name] || name)}`,
  });
}

function payDone() {
  closePayViewer();
  uni.pageScrollTo({ selector: '#payment-form', duration: 300 });
  uni.showToast({ title: '请填写汇款信息并提交', icon: 'none' });
}

async function submit() {
  const { payerName, amount, remark } = form.value;
  if (!payerName?.trim() || !amount) {
    uni.showToast({ title: '请填写汇款人姓名和金额', icon: 'none' });
    return;
  }
  if (Number(amount) !== selectedPrice.value) {
    const plan = plans.find((p) => p.id === selected.value);
    uni.showToast({ title: `请按 ${plan?.label} 金额 ¥${selectedPrice.value} 汇款`, icon: 'none' });
    return;
  }
  submitting.value = true;
  try {
    await submitPayment({
      clientId: clientId.value,
      payerName: payerName.trim(),
      amount: Number(amount),
      paidAt: new Date().toISOString(),
      remark: remark || clientId.value,
      plan: selected.value,
    });
    uni.showModal({
      title: '已提交',
      content: '工作人员核对到账后将开通会员，请留意。',
      showCancel: false,
    });
  } catch (e) {
    uni.showToast({ title: e.message || '提交失败', icon: 'none' });
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  clientId.value = getClientId();
  form.value.remark = clientId.value;
  form.value.amount = String(selectedPrice.value);
  try {
    const data = await fetchPaymentInfo();
    company.value = data.company;
  } catch {
    uni.showToast({ title: '无法加载收款信息', icon: 'none' });
  }
});

onUnmounted(() => {
  stopPolling();
});
</script>

<style lang="scss" scoped>
/* 二维码绘制用画布：移出可视区，避免占用版面 */
.pay-qr-canvas { position: fixed; left: -9999px; top: 0; width: 280px; height: 280px; }

.page {
  padding: 24rpx;
  padding-bottom: 48rpx;
}

.title {
  display: block;
  font-size: 34rpx;
  font-weight: 700;
  color: $color-pink-light;
}

.hint {
  display: block;
  font-size: 24rpx;
  color: $color-text-muted;
  margin-top: 12rpx;
  line-height: 1.5;
}

.pay-hint {
  margin-bottom: 16rpx;
}

.plans {
  display: flex;
  gap: 16rpx;
}

.plan {
  flex: 1;
  text-align: center;
  padding: 24rpx 12rpx;
  border-radius: 16rpx;
  border: 2rpx solid rgba(108, 92, 231, 0.35);
}

.plan-active {
  border-color: $color-pink;
  background: rgba(255, 107, 129, 0.12);
}

.plan-label {
  display: block;
  font-size: 26rpx;
}

.plan-price {
  display: block;
  font-size: 32rpx;
  font-weight: 700;
  color: $color-pink;
  margin-top: 8rpx;
}

.section-title {
  display: block;
  font-size: 28rpx;
  color: $color-pink-light;
  margin-bottom: 16rpx;
}

.pay-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16rpx;
}

.pay-card {
  border-radius: 16rpx;
  border: 2rpx solid rgba(108, 92, 231, 0.35);
  padding: 12rpx;
  text-align: center;
  background: rgba(15, 14, 23, 0.6);
}

.pay-thumb {
  width: 100%;
  height: 220rpx;
}

.pay-label {
  display: block;
  font-size: 24rpx;
  color: $color-text-soft;
  margin-top: 8rpx;
}

.bank-line {
  display: block;
  font-size: 26rpx;
  color: $color-text-soft;
  margin-bottom: 8rpx;
  line-height: 1.5;
}

.form-card {
  padding-bottom: 8rpx;
}

.form-section-title {
  font-size: 32rpx;
  margin-bottom: 12rpx;
}

.form-readable {
  font-size: 28rpx;
  color: $color-text-soft;
  line-height: 1.6;
}

.form-label {
  display: block;
  font-size: 30rpx;
  font-weight: 600;
  color: $color-text;
  margin-bottom: 12rpx;
  margin-top: 8rpx;
}

.field,
.field-lg {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 16rpx;
  padding: 0 24rpx;
  background: $color-bg;
  border: 1rpx solid rgba(108, 92, 231, 0.4);
  border-radius: 12rpx;
  color: $color-text;
}

.field {
  height: 88rpx;
  line-height: 88rpx;
  font-size: 28rpx;
}

.field-lg {
  height: 96rpx;
  line-height: 96rpx;
  font-size: 30rpx;
}

.btn-lg {
  font-size: 32rpx;
  padding: 24rpx;
  margin-top: 16rpx;
}

.btn-outline {
  margin-top: 16rpx;
}

.legal-lg {
  font-size: 26rpx;
  color: #9090a8;
  line-height: 1.6;
}


.btn-block {
  width: 100%;
  margin-top: 8rpx;
}

.btn-sm {
  flex: 1;
  font-size: 24rpx;
  padding: 16rpx 8rpx;
}

.btn-mini {
  font-size: 22rpx;
  padding: 8rpx 16rpx;
  margin-left: 12rpx;
  line-height: 1.4;
}

.legal {
  display: block;
  font-size: 22rpx;
  color: $color-text-faint;
  margin-top: 24rpx;
  line-height: 1.5;
  padding: 0 8rpx;
}

/** 下单前的协议入口（与 legal 同一视觉层级，但可点） */
.legal-links {
  display: flex;
  justify-content: center;
  gap: 12rpx;
  margin-top: 12rpx;
  padding-bottom: 8rpx;
}
.legal-link {
  font-size: 22rpx;
  color: $color-text-faint;
  text-decoration: underline;
}

.pay-viewer {
  position: fixed;
  inset: 0;
  z-index: 999;
  background: rgba(0, 0, 0, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32rpx;
}

.pay-viewer-box {
  width: 100%;
  max-width: 640rpx;
  background: $color-bg-card-alt;
  border-radius: 24rpx;
  padding: 32rpx;
  border: 1rpx solid rgba(108, 92, 231, 0.45);
}

.pay-viewer-title {
  display: block;
  font-size: 32rpx;
  font-weight: 700;
  color: $color-pink-light;
}

.pay-viewer-amount {
  display: block;
  font-size: 30rpx;
  color: $color-pink;
  font-weight: 700;
  margin-top: 16rpx;
}

.pay-viewer-client {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 16rpx;
  gap: 8rpx;
}

.client-text {
  flex: 1;
  font-size: 22rpx;
  color: $color-text-muted;
  word-break: break-all;
}

.pay-viewer-img {
  width: 100%;
  margin-top: 20rpx;
  border-radius: 12rpx;
  background: #fff;
}

.pay-viewer-tip {
  display: block;
  font-size: 22rpx;
  color: $color-text-muted;
  margin-top: 16rpx;
  line-height: 1.5;
}

.pay-online-card {
  border: 2rpx solid rgba(255, 107, 129, 0.35);
  background: rgba(255, 107, 129, 0.08);
}

.pay-viewer-order {
  display: block;
  font-size: 22rpx;
  color: $color-text-muted;
  margin-top: 12rpx;
  word-break: break-all;
}

.pay-viewer-status {
  display: block;
  text-align: center;
  font-size: 24rpx;
  color: $color-pink-light;
  margin-top: 12rpx;
}

.pay-viewer-status.is-paid {
  color: $color-success-bright;
}

.pay-viewer-actions {
  display: flex;
  gap: 12rpx;
  margin-top: 24rpx;
}
</style>
