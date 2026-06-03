<template>
  <view class="page">
    <view class="hero card">
      <text class="tagline">写下你的爱情难题，我教你直线走</text>
      <text class="sub">避坑 + 直线解决 · 3步内给出行动方案</text>
    </view>

    <scroll-view scroll-y class="messages" :scroll-top="scrollTop">
      <view v-if="messages.length === 0" class="welcome">
        👋 你好，我是 Q 智慧顾问。描述情感困境，我会给你直线方案。
      </view>
      <view
        v-for="(m, i) in messages"
        :key="i"
        :class="['msg', m.role === 'user' ? 'msg-user' : 'msg-ai']"
      >
        <text>{{ m.text }}</text>
      </view>
      <view v-if="loading" class="msg msg-ai">思考中…</view>
    </scroll-view>

    <view class="input-area card">
      <textarea
        v-model="question"
        class="input"
        placeholder="例如：暧昧半年对方不确认关系，我该怎么办？"
        :maxlength="500"
        auto-height
      />
      <view class="actions">
        <button class="btn-secondary" size="mini" @click="onVoice">🎤 语音</button>
        <button class="btn-primary" size="mini" :disabled="loading" @click="onAsk">获取直线方案</button>
        <button class="btn-secondary" size="mini" :disabled="!canFollowUp || loading" @click="onFollowUp">
          再问一步
        </button>
      </view>
      <text class="quota">{{ quotaText }}</text>
    </view>
  </view>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { getClientId } from '../../utils/clientId.js';
import { formatQuotaText, addStats } from '../../utils/user.js';
import { askChat } from '../../api/chat.js';
import { fetchQuota } from '../../api/quota.js';

const question = ref('');
const messages = ref([]);
const loading = ref(false);
const quotaText = ref('加载额度…');
const canFollowUp = ref(false);
const scrollTop = ref(0);
let lastQuestion = '';

async function loadQuota() {
  try {
    const q = await fetchQuota(getClientId());
    quotaText.value = formatQuotaText(q);
  } catch {
    quotaText.value = '24 小时内还可提问 5/5 次（离线）';
  }
}

function scrollBottom() {
  scrollTop.value = scrollTop.value === 99999 ? 99998 : 99999;
}

async function doAsk(followUp = false) {
  const text = followUp ? lastQuestion : question.value.trim();
  if (!text) {
    uni.showToast({ title: '请输入问题', icon: 'none' });
    return;
  }
  if (!followUp) {
    messages.value.push({ role: 'user', text });
    lastQuestion = text;
    question.value = '';
  }
  loading.value = true;
  scrollBottom();
  try {
    const data = await askChat(text, getClientId(), followUp);
    messages.value.push({ role: 'ai', text: data.reply });
    addStats(data.qCoins || 0, data.wisdom || 0, 5);
    canFollowUp.value = true;
    if (data.quota) quotaText.value = formatQuotaText(data.quota);
    scrollBottom();
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') {
      uni.showModal({
        title: '提问已达上限',
        content: e.message || '请办理会员或24小时后再试',
        showCancel: false,
      });
    } else {
      uni.showToast({ title: e.message || '请求失败', icon: 'none' });
    }
  } finally {
    loading.value = false;
  }
}

function onAsk() {
  doAsk(false);
}

function onFollowUp() {
  doAsk(true);
}

function onVoice() {
  // #ifdef MP-WEIXIN
  uni.showToast({ title: '请长按说话（后续接录音）', icon: 'none' });
  // #endif
  // #ifndef MP-WEIXIN
  uni.showToast({ title: '当前平台请使用文字输入', icon: 'none' });
  // #endif
}

onMounted(() => {
  loadQuota();
});
</script>

<style lang="scss" scoped>
.page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 24rpx;
  box-sizing: border-box;
}

.hero {
  flex-shrink: 0;
  margin-bottom: 16rpx;
}

.tagline {
  display: block;
  font-size: 32rpx;
  font-weight: 700;
  background: linear-gradient(135deg, #ff6b81, #6c5ce7);
  -webkit-background-clip: text;
  color: transparent;
}

.sub {
  display: block;
  font-size: 24rpx;
  color: #a0a0b0;
  margin-top: 8rpx;
}

.messages {
  flex: 1;
  min-height: 200rpx;
  margin-bottom: 16rpx;
}

.welcome {
  text-align: center;
  color: #a0a0b0;
  font-size: 26rpx;
  padding: 40rpx 20rpx;
}

.msg {
  max-width: 90%;
  padding: 20rpx 24rpx;
  border-radius: 16rpx;
  margin-bottom: 16rpx;
  font-size: 28rpx;
  line-height: 1.5;
  white-space: pre-wrap;
}

.msg-user {
  margin-left: auto;
  background: linear-gradient(135deg, #ff6b81, #6c5ce7);
  color: #fff;
}

.msg-ai {
  background: #242338;
  border-left: 6rpx solid #6c5ce7;
}

.input-area {
  flex-shrink: 0;
}

.input {
  width: 100%;
  min-height: 120rpx;
  background: #0f0e17;
  border: 1rpx solid rgba(108, 92, 231, 0.4);
  border-radius: 16rpx;
  padding: 16rpx;
  color: #f5f5f7;
  font-size: 28rpx;
  box-sizing: border-box;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 16rpx;
  margin-top: 16rpx;
}

.quota {
  display: block;
  font-size: 22rpx;
  color: #a0a0b0;
  margin-top: 12rpx;
}
</style>
