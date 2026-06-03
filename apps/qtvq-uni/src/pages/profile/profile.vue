<template>
  <view class="page">
    <view class="card profile-head">
      <text class="name">我心永恒 · Q问</text>
      <text class="id">设备编号 {{ clientId.slice(0, 20) }}…</text>
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
      <text class="hint">「再问一步」不计入 · 会员对公汇款核实后不限次</text>
    </view>

    <view class="card">
      <text class="section-title">缘认知（MVP）</text>
      <text class="fate">根据提问与浏览，推荐适合类型与常见坑。完整缘匹配见 Web 版「我的缘值」。</text>
    </view>

    <view class="card">
      <text class="section-title">关于</text>
      <text class="about">qtvq.cn · 京ICP备19045082号\nAPI: qtvq-api.pages.dev</text>
    </view>
  </view>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { getClientId } from '../../utils/clientId.js';
import { getUser, formatQuotaText } from '../../utils/user.js';
import { fetchQuota } from '../../api/quota.js';

const clientId = ref('');
const user = ref(getUser());
const quotaText = ref('加载中…');

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
  padding: 40rpx 24rpx;
}

.name {
  display: block;
  font-size: 36rpx;
  font-weight: 700;
}

.id {
  display: block;
  font-size: 22rpx;
  color: #a0a0b0;
  margin-top: 12rpx;
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
.hint,
.fate,
.about {
  display: block;
  font-size: 26rpx;
  line-height: 1.5;
  color: #a0a0b0;
}

.hint {
  margin-top: 8rpx;
  font-size: 22rpx;
}

.about {
  white-space: pre-wrap;
}
</style>
