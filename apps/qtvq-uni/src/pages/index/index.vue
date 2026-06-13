<template>
  <view class="page">
    <view class="hero card">
      <image class="logo" src="@/static/logo-108.png" mode="aspectFit" />
      <text class="tagline">写下你的爱情难题，我教你直线走</text>
      <text class="sub">避坑 + 直线解决 · {{ platformName }}</text>
    </view>

    <scroll-view v-if="hotTopics.length" scroll-x class="hot-scroll" show-scrollbar="false">
      <view class="hot-row">
        <view v-for="(t, i) in hotTopics" :key="i" class="hot-chip" @click="fillQuestion(t.text)">
          <text>{{ t.text }}</text>
        </view>
      </view>
    </scroll-view>

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

    <scroll-view v-if="stories.length" scroll-x class="stories-scroll" show-scrollbar="false">
      <view class="stories-row">
        <view v-for="(s, i) in stories" :key="i" class="story-card" @click="fillQuestion(s.prompt)">
          <text class="story-tag">{{ s.tag }}</text>
          <text class="story-text">{{ s.text }}</text>
        </view>
      </view>
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
        <button
          class="btn-secondary voice-btn"
          size="mini"
          :class="{ recording: voiceRecording }"
          @click="onVoice"
        >
          {{ voiceRecording ? '⏹ 停止' : '🎤 语音' }}
        </button>
        <button class="btn-primary" size="mini" :disabled="loading" @click="onAsk">获取直线方案</button>
        <button class="btn-secondary" size="mini" :disabled="!canFollowUp || loading" @click="onFollowUp">
          再问一步
        </button>
      </view>
      <view class="quota-row">
        <text class="quota">{{ quotaText }}</text>
        <text class="link" @click="goSubscribe">办理会员</text>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import { getClientId } from '../../utils/clientId.js';
import { formatQuotaText, addStats } from '../../utils/user.js';
import { askChat } from '../../api/chat.js';
import { fetchQuota } from '../../api/quota.js';
import { HOT_TOPICS, SUCCESS_STORIES } from '../../data/constants.js';
import { platformLabel } from '../../utils/platform.js';
import {
  checkSpeechAvailable,
  startRecording,
  stopRecording,
  isRecording,
} from '../../utils/voice.js';

const question = ref('');
const messages = ref([]);
const loading = ref(false);
const quotaText = ref('加载额度…');
const canFollowUp = ref(false);
const scrollTop = ref(0);
const voiceRecording = ref(false);
const speechOk = ref(false);
const hotTopics = HOT_TOPICS;
const stories = SUCCESS_STORIES;
const platformName = platformLabel();
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

function fillQuestion(text) {
  question.value = text;
  uni.showToast({ title: '已填入问题', icon: 'none' });
}

function goSubscribe() {
  uni.navigateTo({ url: '/pages/subscribe/subscribe' });
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
        content: '可办理会员不限次，或24小时后再试',
        confirmText: '办理会员',
        success: (res) => {
          if (res.confirm) goSubscribe();
        },
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

async function onVoice() {
  // #ifdef MP
  if (!speechOk.value) {
    uni.showToast({ title: '语音识别未配置，请用文字', icon: 'none' });
    return;
  }
  if (voiceRecording.value || isRecording()) {
    voiceRecording.value = false;
    uni.showLoading({ title: '识别中…' });
    try {
      const { base64, format, sampleRate } = await stopRecording();
      const { transcribeAudio } = await import('../../api/speech.js');
      const result = await transcribeAudio(base64, format, sampleRate);
      const text = (result.text || '').trim();
      if (text) {
        question.value = question.value ? `${question.value} ${text}` : text;
        uni.showToast({ title: '已填入语音', icon: 'none' });
      } else {
        uni.showToast({ title: '未识别到语音', icon: 'none' });
      }
    } catch (e) {
      uni.showToast({ title: e.message || '语音识别失败', icon: 'none' });
    } finally {
      uni.hideLoading();
    }
    return;
  }
  try {
    await startRecording();
    voiceRecording.value = true;
    uni.showToast({ title: '正在录音，再点停止', icon: 'none' });
  } catch {
    uni.showToast({ title: '无法访问麦克风', icon: 'none' });
  }
  // #endif
  // #ifndef MP
  uni.showToast({ title: '请在微信/支付宝小程序使用语音', icon: 'none' });
  // #endif
}

onLoad((opts) => {
  if (opts?.q) {
    question.value = decodeURIComponent(opts.q);
  }
});

onShow(() => {
  try {
    const prefill = uni.getStorageSync('qtvq_prefill');
    if (prefill) {
      question.value = prefill;
      uni.removeStorageSync('qtvq_prefill');
    }
  } catch {
    /* ignore */
  }
});

onMounted(async () => {
  loadQuota();
  speechOk.value = await checkSpeechAvailable();
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
  margin-bottom: 12rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.logo {
  width: 72rpx;
  height: 72rpx;
  margin-bottom: 8rpx;
}

.tagline {
  display: block;
  font-size: 32rpx;
  font-weight: 700;
  background: linear-gradient(135deg, #ff6b81, #6c5ce7);
  -webkit-background-clip: text;
  color: transparent;
  text-align: center;
}

.sub {
  display: block;
  font-size: 22rpx;
  color: #a0a0b0;
  margin-top: 8rpx;
}

.hot-scroll,
.stories-scroll {
  flex-shrink: 0;
  white-space: nowrap;
  margin-bottom: 12rpx;
}

.hot-row,
.stories-row {
  display: inline-flex;
  gap: 12rpx;
  padding: 4rpx 0;
}

.hot-chip {
  display: inline-block;
  padding: 12rpx 20rpx;
  background: #242338;
  border-radius: 999rpx;
  font-size: 22rpx;
  color: #c8c8d8;
  max-width: 420rpx;
  overflow: hidden;
  text-overflow: ellipsis;
}

.story-card {
  display: inline-flex;
  flex-direction: column;
  width: 320rpx;
  padding: 16rpx;
  background: #242338;
  border-radius: 16rpx;
  border: 1rpx solid rgba(108, 92, 231, 0.35);
}

.story-tag {
  font-size: 20rpx;
  color: #6c5ce7;
  margin-bottom: 8rpx;
}

.story-text {
  font-size: 22rpx;
  color: #a0a0b0;
  white-space: normal;
  line-height: 1.4;
}

.messages {
  flex: 1;
  min-height: 160rpx;
  margin-bottom: 12rpx;
}

.welcome {
  text-align: center;
  color: #a0a0b0;
  font-size: 26rpx;
  padding: 24rpx 20rpx;
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

.voice-btn.recording {
  color: #ff6b81;
  border-color: #ff6b81;
}

.quota-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 12rpx;
}

.quota {
  font-size: 22rpx;
  color: #a0a0b0;
}

.link {
  font-size: 22rpx;
  color: #6c5ce7;
}
</style>
