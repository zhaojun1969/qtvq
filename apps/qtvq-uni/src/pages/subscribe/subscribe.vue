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

    <view class="card pay-online-card">
      <text class="section-title">微信在线支付（自动到账）</text>
      <text class="hint pay-hint">生成专属订单码，支付成功后自动开通，无需人工核实。</text>
      <button class="btn-primary btn-block" :disabled="onlineLoading" @click="startOnlinePay">
        {{ onlineLoading ? '创建订单中…' : '微信在线支付' }}
      </button>
    </view>

    <view class="card">
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

    <view v-if="company" class="card">
      <text class="section-title">对公银行汇款</text>
      <text class="bank-line">户名：{{ company.name }}</text>
      <text class="bank-line">账号：{{ company.cardNo }}</text>
      <text class="bank-line">开户行：{{ company.bank }}</text>
      <text class="bank-line">备注建议填设备编号</text>
      <button class="btn-secondary btn-block" @click="copyBank">复制账号</button>
    </view>

    <view id="payment-form" class="card">
      <text class="section-title">提交汇款核实</text>
      <text class="hint pay-hint">扫码或对公汇款后填写，便于核对开通会员。</text>
      <input v-model="form.payerName" class="field" placeholder="汇款人姓名" />
      <input v-model="form.amount" class="field" type="digit" placeholder="汇款金额（元）" />
      <input v-model="form.remark" class="field" placeholder="备注 / 设备编号" />
      <button class="btn-primary btn-block" :disabled="submitting" @click="submit">我已汇款，提交核实</button>
    </view>

    <text class="legal">收款方：我心永恒（北京）网络科技有限公司。核实到账后开通会员。</text>

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
import { PLANS } from '../../data/constants.js';
import { PAY_CHANNELS } from '../../data/pay-channels.js';
import { fetchPaymentInfo, submitPayment } from '../../api/quota.js';
import { createWechatPayOrder, pollWechatPayOrder } from '../../api/payment-wechat.js';
import { qrCodeImageUrl } from '../../utils/qr-render.js';
import { getClientId } from '../../utils/clientId.js';

const plans = PLANS;
const payChannels = PAY_CHANNELS;
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

const selectedPrice = computed(() => plans.find((p) => p.id === selected.value)?.price || 28);

function selectPlan(id) {
  selected.value = id;
  form.value.amount = String(selectedPrice.value);
}

function openPayViewer(ch) {
  stopPolling();
  viewerMode.value = 'static';
  viewerTitle.value = `${ch.label} · 扫码付款`;
  viewerTip.value = ch.tip;
  viewerImage.value = ch.image;
  viewerOrderId.value = '';
  viewerStatus.value = '';
  viewerPaid.value = false;
  viewerOpen.value = true;
}

function openOnlineViewer(data) {
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

  viewerTitle.value = '微信在线支付 · 扫码付款';
  viewerTip.value = '请用微信扫一扫；支付成功后自动开通会员。';
  viewerImage.value = data.codeUrl ? qrCodeImageUrl(data.codeUrl, 280) : '';
  viewerStatus.value = '等待支付中…';
  viewerOpen.value = true;

  if (data.jsapi) {
    uni.requestPayment({
      provider: 'wxpay',
      timeStamp: data.jsapi.timeStamp,
      nonceStr: data.jsapi.nonceStr,
      package: data.jsapi.package,
      signType: data.jsapi.signType || 'RSA',
      paySign: data.jsapi.paySign,
      fail: () => {
        /* 用户取消则继续展示二维码 */
      },
    });
  }

  if (data.orderId) {
    stopPoll = pollWechatPayOrder(data.orderId, {
      onPaid: () => {
        viewerStatus.value = '✓ 支付成功，会员已开通';
        viewerPaid.value = true;
        uni.showToast({ title: '会员已开通', icon: 'success' });
      },
    });
  }
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

async function startOnlinePay() {
  onlineLoading.value = true;
  try {
    const data = await createWechatPayOrder(selected.value, 'native');
    if (data.stub && !data.codeUrl) {
      uni.showToast({ title: data.message || '在线支付未配置', icon: 'none' });
    }
    openOnlineViewer(data);
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
.page {
  padding: 24rpx;
  padding-bottom: 48rpx;
}

.title {
  display: block;
  font-size: 34rpx;
  font-weight: 700;
  color: #ff8fa3;
}

.hint {
  display: block;
  font-size: 24rpx;
  color: #a0a0b0;
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
  border-color: #ff6b81;
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
  color: #ff6b81;
  margin-top: 8rpx;
}

.section-title {
  display: block;
  font-size: 28rpx;
  color: #ff8fa3;
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
  color: #c8c8d8;
  margin-top: 8rpx;
}

.bank-line {
  display: block;
  font-size: 26rpx;
  color: #c8c8d8;
  margin-bottom: 8rpx;
  line-height: 1.5;
}

.field {
  width: 100%;
  background: #0f0e17;
  border: 1rpx solid rgba(108, 92, 231, 0.4);
  border-radius: 12rpx;
  padding: 20rpx;
  color: #f5f5f7;
  font-size: 28rpx;
  margin-bottom: 16rpx;
  box-sizing: border-box;
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
  color: #707080;
  margin-top: 24rpx;
  line-height: 1.5;
  padding: 0 8rpx;
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
  background: #1a1925;
  border-radius: 24rpx;
  padding: 32rpx;
  border: 1rpx solid rgba(108, 92, 231, 0.45);
}

.pay-viewer-title {
  display: block;
  font-size: 32rpx;
  font-weight: 700;
  color: #ff8fa3;
}

.pay-viewer-amount {
  display: block;
  font-size: 30rpx;
  color: #ff6b81;
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
  color: #a0a0b0;
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
  color: #a0a0b0;
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
  color: #a0a0b0;
  margin-top: 12rpx;
  word-break: break-all;
}

.pay-viewer-status {
  display: block;
  text-align: center;
  font-size: 24rpx;
  color: #ff8fa3;
  margin-top: 12rpx;
}

.pay-viewer-status.is-paid {
  color: #7bed9f;
}

.pay-viewer-actions {
  display: flex;
  gap: 12rpx;
  margin-top: 24rpx;
}
</style>
