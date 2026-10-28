<template>
  <view class="page" :style="{ height: pageHeightPx + 'px' }">
    <BrandNavBar
      :status-bar-px="statusBarPx"
      :nav-bar-px="navBarPx"
      :nav-total-px="navTotalPx"
      center-title="缘值"
    />
    <scroll-view
      scroll-y
      class="page-scroll"
      :style="{ height: scrollHeightPx + 'px' }"
      enable-back-to-top
      :show-scrollbar="true"
    >
      <view class="page-inner">
      <view class="card profile-head">
        <image class="logo" src="@/static/logo-108.png" mode="aspectFit" />
        <text class="name">我心永恒 · Q问</text>
        <text class="id">设备编号 {{ clientIdShort }}</text>
        <text class="platform">{{ platformName }}</text>
      </view>

      <view class="stats card">
        <text class="section-title">激励体系</text>
        <text class="hint stats-hint">完成提问得 Q币 · 阅读避坑得直线值 · Q币+智慧值解锁深度内容</text>
        <view class="stats-row">
          <view class="stat">
            <text class="num">{{ user.qCoins }}</text>
            <text class="label">Q币</text>
          </view>
          <view class="stat">
            <text class="num">{{ user.wisdom }}</text>
            <text class="label">智慧</text>
          </view>
          <view class="stat">
            <text class="num">{{ user.lineValue }}</text>
            <text class="label">直线</text>
          </view>
        </view>
        <text class="hint progress-hint">解锁进度（200 分解锁直播答疑）</text>
        <view class="progress-bar">
          <view class="progress-fill" :style="{ width: unlockPercent + '%' }" />
        </view>
      </view>

      <view class="card member-card">
        <text class="section-title">Q问 提问会员</text>
        <text class="hint pricing-hint">月卡 ¥29 · 季卡 ¥79 · 年卡 ¥299</text>
        <text class="quota">{{ quotaText }}</text>
        <text v-if="subscriptionDetail" class="subscription-detail">{{ subscriptionDetail }}</text>
        <view v-if="payStatus" :class="['pay-status', payStatus.type]">
          <text class="pay-status-title">{{ payStatus.title }}</text>
          <text class="pay-status-detail">{{ payStatus.detail }}</text>
        </view>
        <button class="btn-primary btn-block" hover-class="button-hover" @tap="goSubscribe">
          {{ isMember ? '续费会员' : '办理会员不限次' }}
        </button>
        <button class="btn-secondary btn-block" hover-class="button-hover" @tap="goAccount">我的账户 · 打款查询</button>
      </view>

      <view class="card menu">
        <view class="menu-item" hover-class="menu-item-hover" @tap="openWeb('help')">
          <text>使用帮助</text>
          <text class="arrow">›</text>
        </view>
        <view class="menu-item" hover-class="menu-item-hover" @tap="openWeb('terms')">
          <text>用户协议</text>
          <text class="arrow">›</text>
        </view>
        <view class="menu-item" hover-class="menu-item-hover" @tap="openWeb('privacy')">
          <text>隐私说明</text>
          <text class="arrow">›</text>
        </view>
        <!-- 自助导出：审核与个保法都要求"可携带"，入口必须自己找得到，不能只在网页版 -->
        <view class="menu-item" hover-class="menu-item-hover" @tap="exportData">
          <text>导出我的数据</text>
          <text class="arrow">›</text>
        </view>
        <view class="menu-item" hover-class="menu-item-hover" @tap="openWeb('download')">
          <text>客户端下载</text>
          <text class="arrow">›</text>
        </view>
        <view class="menu-item" hover-class="menu-item-hover" @tap="openContact">
          <text>联系客服 qtvq@qtvq.cn</text>
          <text class="arrow">›</text>
        </view>
        <view class="menu-item" hover-class="menu-item-hover" @tap="copyClientId">
          <text>复制设备编号</text>
          <text class="arrow">›</text>
        </view>
      </view>

      <view class="card">
        <text class="section-title">我的资料（转盘前置）</text>
        <text class="hint">转盘只出异性候选，所以必须先填「昵称 + 性别」，否则转盘按钮不可用。</text>
        <view class="form-row">
          <text class="form-label">昵称</text>
          <input v-model="profile.nickname" class="form-input" placeholder="必填" />
        </view>
        <view class="form-row">
          <text class="form-label">性别</text>
          <view class="gender-row">
            <button size="mini" :class="['gender-btn', profile.gender === 'male' ? 'active' : '']" @tap="profile.gender = 'male'">男</button>
            <button size="mini" :class="['gender-btn', profile.gender === 'female' ? 'active' : '']" @tap="profile.gender = 'female'">女</button>
          </view>
        </view>
        <view class="form-row">
          <text class="form-label">年龄</text>
          <input v-model="profile.age" class="form-input" type="number" placeholder="选填" />
        </view>
        <view class="form-row">
          <text class="form-label">城市</text>
          <input v-model="profile.city" class="form-input" placeholder="选填" />
        </view>
        <view class="form-row">
          <text class="form-label">标签</text>
          <input v-model="profile.tags" class="form-input" placeholder="用、分隔，如：读书、旅行" />
        </view>
        <view class="form-row">
          <text class="form-label">简介</text>
          <input v-model="profile.intro" class="form-input" placeholder="选填" />
        </view>
        <button class="btn-primary" :disabled="profileSaving" @tap="submitProfile">
          {{ profileSaving ? '保存中…' : '保存资料' }}
        </button>
        <text v-if="profileMsg" class="form-msg">{{ profileMsg }}</text>
      </view>

      <view class="card">
        <text class="section-title">我的缘值</text>
        <text class="hint">
          缘值用于转盘（每次 ¥1）与配对报告扣费；会员费不含缘值，两笔钱互不通用。
          <text v-if="wallet">当前余额 ¥{{ Number(wallet.balance || 0).toFixed(2) }}</text>
        </text>
        <button class="btn-primary" @tap="goWallet">查看缘值余额与流水 →</button>
        <button class="btn-secondary" @tap="goRecharge">缘值充值（微信在线支付，自动到账）</button>
      </view>

      <view class="card">
        <text class="section-title">转盘配对</text>
        <text class="hint">从真实异性别用户里转出一位；每次 ¥1（会员每日免一次），从缘值扣。</text>
        <button class="btn-primary" @tap="goWheel">去转盘配对 →</button>
        <button class="btn" size="mini" @tap="goReportPage">生成配对报告 →</button>
      </view>

      <view class="card">
        <text class="section-title">关于</text>
        <text class="about">qtvq.cn · 京ICP备19045082号\n版本 {{ appVersion }} · 会员 ¥29/79/299\nAPI: qtvq.cn</text>
      </view>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { getClientId } from '../../utils/clientId.js';
import {
  getUser,
  formatQuotaText,
  formatSubscriptionDetail,
  applyQuotaToUser,
  isActiveMember,
} from '../../utils/user.js';
import { fetchQuota } from '../../api/quota.js';
import { fetchMyProfile, saveMyProfile } from '../../api/profile.js';
import { track } from '../../utils/track.js';
import { fetchWallet } from '../../api/wallet.js';
import { fetchMyData, shareMyData } from '../../api/export.js';
import { isLoggedIn } from '../../utils/auth.js';
import { platformLabel } from '../../utils/platform.js';
import { WEB_BASE, APP_VERSION } from '../../data/constants.js';
import BrandNavBar from '../../components/BrandNavBar.vue';
import { useNavBar } from '../../utils/navBar.js';

const { statusBarPx, navBarPx, navTotalPx, pageHeightPx, bodyHeightPx, initNavBar } = useNavBar();
const scrollHeightPx = computed(() => bodyHeightPx.value);
const clientId = ref('');
const user = ref(getUser());
const quota = ref(null);
const platformName = platformLabel();
const appVersion = APP_VERSION;
const clientIdShort = computed(() => {
  const id = clientId.value || '';
  return id.length > 16 ? `${id.slice(0, 16)}…` : id;
});

const quotaText = computed(() => (quota.value ? formatQuotaText(quota.value) : '加载中…'));
const subscriptionDetail = computed(() => formatSubscriptionDetail(quota.value));
const isMember = computed(() => isActiveMember(quota.value));

/* ── 我的资料（转盘的硬前置：没有昵称+性别，转盘会拒绝转动）── */
const profile = ref({ nickname: '', gender: '', age: '', city: '', tags: '', intro: '' });
const profileReady = ref(false);
const profileSaving = ref(false);
const profileMsg = ref('');
const wallet = ref(null);

/**
 * 加载「我的资料」（Node 侧 /v1/profile/me）。
 * ⚠️ 注意不能叫 loadProfile —— 本页已有的 loadProfile 是加载**额度**的，
 * 同名会覆盖、导致额度和会员状态永远不刷新。
 */
async function loadMyProfile() {
  try {
    const data = await fetchMyProfile();
    const u = data.user || data.data || data || {};
    profile.value = {
      nickname: u.nickname || '',
      gender: u.gender || '',
      age: u.age || '',
      city: u.city || '',
      tags: (u.tags || []).join('、'),
      intro: u.intro || '',
    };
    profileReady.value = !!(u.nickname && u.gender);
  } catch (e) {
    // 未登录时这里会失败，属正常：提示登录而不是报错
    profileMsg.value = e?.statusCode === 401 ? '登录后可填写资料并转动转盘' : e?.message || '';
  }
}

async function loadWallet() {
  try {
    const w = await fetchWallet();
    wallet.value = w.wallet || w;
  } catch {
    /* 未登录时忽略 */
  }
}

async function submitProfile() {
  const p = profile.value;
  if (!p.nickname || !p.gender) {
    profileMsg.value = '昵称与性别必填（转盘需要性别才能只出异性）';
    return;
  }
  profileSaving.value = true;
  profileMsg.value = '';
  try {
    const patch = {
      nickname: p.nickname,
      gender: p.gender,
      tags: String(p.tags || '')
        .split(/[、,，\s]+/)
        .filter(Boolean)
        .slice(0, 8),
      intro: p.intro || '',
    };
    if (p.age) patch.age = Number(p.age);
    if (p.city) patch.city = p.city;
    const res = await saveMyProfile(patch);
    profileReady.value = true;
    profileMsg.value = '已保存 ✅ 现在可以去转盘了';
    /*
     * 激活口径的另一半（见 `metrics.js::ACTIVATION_EVENTS`）。
     * 「完成资料」按产品自己的定义算：保存时前端强制昵称+性别、服务端再校验一次，
     * 能存成功就是可用资料 —— 不另设"完成度 ≥ X%"的阈值，否则看板与产品两套口径。
     * `completeness` 只作为分析字段带上（服务端 6 项检查的得分）。
     */
    track('profile_complete', { completeness: res?.data?.user?.completeness ?? null });
  } catch (e) {
    profileMsg.value = e?.message || '保存失败';
  } finally {
    profileSaving.value = false;
  }
}

function goWheel() {
  uni.navigateTo({ url: '/pages/wheel/wheel' });
}

function goReportPage() {
  uni.navigateTo({ url: '/pages/report/report' });
}

function goRecharge() {
  // 充值在钱包页完成（原来指到账户页，而账户页没有充值入口 —— 用户点了等于走进死胡同）
  uni.navigateTo({ url: '/pages/wallet/wallet' });
}

function goWallet() {
  uni.navigateTo({ url: '/pages/wallet/wallet' });
}

const unlockPercent = computed(() => {
  const u = user.value;
  const total = (u.qCoins || 0) + (u.wisdom || 0);
  return Math.min(100, Math.round((total / 200) * 100));
});

const payStatus = computed(() => {
  const q = quota.value;
  if (!q?.paymentPending || q.paymentPending.status !== 'pending') return null;
  const p = q.paymentPending;
  return {
    type: 'pending',
    title: '⏳ 打款核实中',
    detail: `${p.planLabel || p.plan} · ¥${p.amount} · 汇款人 ${p.payerName || '—'}`,
  };
});

function goSubscribe() {
  uni.navigateTo({ url: '/pages/subscribe/subscribe' });
}

function goAccount() {
  uni.navigateTo({ url: '/pages/account/account' });
}

/**
 * 用 web-view 打开官网页面（帮助 / 用户协议 / 隐私说明 / 下载）。
 *
 * 标题必须走映射表：原来直接把 page 当标题传，导航栏显示的是 `terms`、`privacy`
 * 这种英文文件名 —— 协议页顶着一个英文单词，审核侧看起来像"未汉化的脚手架页面"。
 * 新增页面时在这里补一行，缺了会退回文件名（不白屏，仍可用）。
 */
const WEB_TITLES = {
  help: '使用帮助',
  terms: '用户协议',
  privacy: '隐私说明',
  download: '客户端下载',
};

function openWeb(page) {
  const url = `${WEB_BASE}/${page}.html`;
  const title = WEB_TITLES[page] || page;
  uni.navigateTo({
    url: `/pages/webview/webview?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}`,
  });
}

function openContact() {
  uni.navigateTo({ url: '/pages/contact/contact' });
}

function copyClientId() {
  uni.setClipboardData({
    data: clientId.value,
    success: () => uni.showToast({ title: '已复制', icon: 'none' }),
  });
}

/**
 * 导出我的数据。
 *
 * 为什么要有这个入口：`dataExport` 以前是 false，DSAR 只能人工受理 ——
 * 那是"用户要发邮件、等人处理"，不是"用了就能拿走"。现在接口有了，
 * 入口就必须放在用户找得到的地方（我的 → 导出我的数据），
 * 而不是藏在某个只在网页版出现的角落。
 */
let exporting = false;
async function exportData() {
  if (exporting) return;
  if (!isLoggedIn()) {
    uni.showToast({ title: '请先登录后再导出', icon: 'none' });
    return;
  }
  exporting = true;
  uni.showLoading({ title: '正在打包…', mask: true });
  try {
    const data = await fetchMyData();
    uni.hideLoading();
    const { mode } = await shareMyData(data);
    if (mode === 'file') {
      uni.showModal({
        title: '已生成文件',
        content: '在发送面板里选「文件传输助手」发给自己，即可保存到电脑。文件不含他人信息与登录凭据。',
        showCancel: false,
        confirmText: '知道了',
      });
    } else {
      uni.showToast({ title: '数据已复制，可粘贴保存', icon: 'none', duration: 3000 });
    }
  } catch (err) {
    uni.hideLoading();
    uni.showToast({ title: err?.message || '导出失败，请稍后再试', icon: 'none', duration: 3000 });
  } finally {
    exporting = false;
  }
}

async function loadProfile() {
  clientId.value = getClientId();
  user.value = getUser();
  try {
    const q = await fetchQuota(clientId.value);
    quota.value = q;
    user.value = applyQuotaToUser(q);
  } catch {
    quota.value = null;
  }
}

onMounted(() => {
  initNavBar();
  loadProfile();
  loadMyProfile();
  loadWallet();
});

onShow(() => {
  loadProfile();
  loadMyProfile();
  loadWallet();
});
</script>

<style lang="scss" scoped>
.page {
  display: flex;
  flex-direction: column;
  background: $color-bg;
  overflow: hidden;
  box-sizing: border-box;
}

.page-scroll {
  width: 100%;
  flex-shrink: 0;
}

.page-inner {
  padding: 0 24rpx 32rpx;
  padding-bottom: calc(32rpx + env(safe-area-inset-bottom));
  box-sizing: border-box;
}

.profile-head {
  text-align: center;
  padding: 32rpx 24rpx;
}

/* 资料表单 + 转盘入口 */
.form-row {
  display: flex;
  align-items: center;
  margin-bottom: 16rpx;
}
.form-label {
  width: 110rpx;
  font-size: 26rpx;
  color: $color-text-dim;
  flex-shrink: 0;
}
.form-input {
  flex: 1;
  background: $color-bg-deep;
  color: $color-text-bright;
  border-radius: 10rpx;
  padding: 14rpx 18rpx;
  font-size: 26rpx;
}
.gender-row {
  display: flex;
  gap: 16rpx;
}
.gender-btn {
  background: $color-bg-deep;
  color: $color-text-dim;
  border-radius: 999rpx;
}
.gender-btn.active {
  background: $color-pink;
  color: #fff;
}
.btn-primary {
  background: $color-pink;
  color: #fff;
  border-radius: 999rpx;
  margin-top: 16rpx;
}
.form-msg {
  display: block;
  margin-top: 12rpx;
  font-size: 24rpx;
  color: $color-text-dim;
}

.logo {
  width: 96rpx;
  height: 96rpx;
  margin-bottom: 12rpx;
}

.name {
  display: block;
  font-size: 36rpx;
  font-weight: 700;
  color: $color-text;
}

.id,
.platform {
  display: block;
  font-size: 22rpx;
  color: $color-text-muted;
  margin-top: 8rpx;
}

.stats {
  padding: 24rpx;
}

.stats-hint,
.progress-hint,
.pricing-hint {
  display: block;
  font-size: 24rpx;
  color: $color-text-muted;
  line-height: 1.5;
  margin-bottom: 16rpx;
}

.stats-row {
  display: flex;
  justify-content: space-around;
  padding: 16rpx 0 24rpx;
}

.progress-bar {
  height: 16rpx;
  background: rgba(108, 92, 231, 0.25);
  border-radius: 8rpx;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, $color-purple, $color-pink);
  border-radius: 8rpx;
  min-width: 0;
  transition: width 0.3s ease;
}

.member-card {
  margin-top: 0;
}

.subscription-detail {
  display: block;
  font-size: 26rpx;
  line-height: 1.6;
  color: $color-text-soft;
  margin-bottom: 16rpx;
}

.pay-status {
  padding: 20rpx;
  border-radius: 12rpx;
  margin-bottom: 16rpx;
}

.pay-status.ok {
  background: rgba(123, 237, 159, 0.12);
  border: 1rpx solid rgba(123, 237, 159, 0.35);
}

.pay-status.pending {
  background: rgba(255, 143, 163, 0.1);
  border: 1rpx solid rgba(255, 143, 163, 0.35);
}

.pay-status-title {
  display: block;
  font-size: 28rpx;
  font-weight: 600;
  color: $color-text;
}

.pay-status-detail {
  display: block;
  font-size: 24rpx;
  color: $color-text-muted;
  margin-top: 8rpx;
  line-height: 1.5;
}

.stat {
  text-align: center;
}

.num {
  display: block;
  font-size: 40rpx;
  font-weight: 700;
  color: $color-pink;
}

.label {
  font-size: 24rpx;
  color: $color-text-muted;
}

.section-title {
  display: block;
  font-size: 28rpx;
  color: $color-pink-light;
  margin-bottom: 12rpx;
}

.quota,
.about {
  display: block;
  font-size: 26rpx;
  line-height: 1.5;
  color: $color-text-muted;
  margin-bottom: 16rpx;
}

.btn-block {
  width: 100%;
  margin-top: 8rpx;
}

.button-hover {
  opacity: 0.85;
}

.menu-item-hover {
  opacity: 0.75;
  background: rgba(108, 92, 231, 0.08);
}

.menu-item {
  display: flex;
  justify-content: space-between;
  padding: 24rpx 0;
  border-bottom: 1rpx solid rgba(108, 92, 231, 0.2);
  font-size: 28rpx;
}

.menu-item:last-child {
  border-bottom: none;
}

.arrow {
  color: $color-purple;
}

.about {
  white-space: pre-wrap;
}
</style>
