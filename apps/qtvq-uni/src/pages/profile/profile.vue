<template>
  <view class="page">
    <view class="card profile-head">
      <image class="logo" src="@/static/logo-108.png" mode="aspectFit" />
      <text class="name">我心永恒 · Q问</text>
      <text class="id">设备编号 {{ clientIdShort }}</text>
      <text class="platform">{{ platformName }}</text>
    </view>

    <view class="stats card">
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

    <view class="card">
      <text class="section-title">提问额度</text>
      <text class="quota">{{ quotaText }}</text>
      <button class="btn-primary btn-block" @click="goSubscribe">办理会员不限次</button>
      <button class="btn-secondary btn-block" @click="goAccount">我的账户 · 打款查询</button>
    </view>

    <view class="card menu">
      <view class="menu-item" @click="openWeb('help')">
        <text>使用帮助</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @click="openWeb('privacy')">
        <text>隐私说明</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @click="openWeb('download')">
        <text>客户端下载</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @click="openContact">
        <text>联系客服 qtvq@qtvq.cn</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @click="copyClientId">
        <text>复制设备编号</text>
        <text class="arrow">›</text>
      </view>
    </view>

    <view class="card">
      <text class="section-title">关于</text>
      <text class="about">qtvq.cn · 京ICP备19045082号\n版本 {{ appVersion }} · 会员 ¥29/79/299\nAPI: qtvq-api.pages.dev</text>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { getClientId } from '../../utils/clientId.js';
import { getUser, formatQuotaText } from '../../utils/user.js';
import { fetchQuota } from '../../api/quota.js';
import { platformLabel } from '../../utils/platform.js';
import { WEB_BASE, APP_VERSION } from '../../data/constants.js';

const clientId = ref('');
const user = ref(getUser());
const quotaText = ref('加载中…');
const platformName = platformLabel();
const appVersion = APP_VERSION;
const clientIdShort = computed(() => {
  const id = clientId.value || '';
  return id.length > 16 ? `${id.slice(0, 16)}…` : id;
});

function goSubscribe() {
  uni.navigateTo({ url: '/pages/subscribe/subscribe' });
}

function goAccount() {
  uni.navigateTo({ url: '/pages/account/account' });
}

function openWeb(page) {
  const url = `${WEB_BASE}/${page}.html`;
  uni.navigateTo({
    url: `/pages/webview/webview?url=${encodeURIComponent(url)}&title=${encodeURIComponent(page)}`,
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

onMounted(async () => {
  clientId.value = getClientId();
  user.value = getUser();
  try {
    const q = await fetchQuota(clientId.value);
    quotaText.value = formatQuotaText(q);
  } catch {
    quotaText.value = '24 小时内还可提问 5/5 次';
  }
});
</script>

<style lang="scss" scoped>
.page {
  padding: 24rpx;
  padding-bottom: 120rpx;
}

.profile-head {
  text-align: center;
  padding: 32rpx 24rpx;
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
}

.id,
.platform {
  display: block;
  font-size: 22rpx;
  color: #a0a0b0;
  margin-top: 8rpx;
}

.stats {
  display: flex;
  justify-content: space-around;
  padding: 32rpx 0;
}

.stat {
  text-align: center;
}

.num {
  display: block;
  font-size: 40rpx;
  font-weight: 700;
  color: #ff6b81;
}

.label {
  font-size: 24rpx;
  color: #a0a0b0;
}

.section-title {
  display: block;
  font-size: 28rpx;
  color: #ff8fa3;
  margin-bottom: 12rpx;
}

.quota,
.about {
  display: block;
  font-size: 26rpx;
  line-height: 1.5;
  color: #a0a0b0;
  margin-bottom: 16rpx;
}

.btn-block {
  width: 100%;
  margin-top: 8rpx;
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
  color: #6c5ce7;
}

.about {
  white-space: pre-wrap;
}
</style>
