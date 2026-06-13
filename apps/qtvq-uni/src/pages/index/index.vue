<template>
  <view class="page">
    <!-- 顶栏：Logo + Q问（与系统导航同一行位置） -->
    <view class="custom-nav" :style="{ paddingTop: statusBarPx + 'px', height: navTotalPx + 'px' }">
      <view class="nav-inner" :style="{ height: navBarPx + 'px' }">
        <image class="nav-logo" src="@/static/logo-108.png" mode="aspectFit" />
        <view class="nav-text">
          <text class="nav-title">Q问</text>
          <text class="nav-sub">我心永恒 · qtvq.cn</text>
        </view>
      </view>
    </view>

    <view class="page-body" :style="{ paddingTop: navTotalPx + 'px' }">
      <scroll-view v-if="hotTopics.length" scroll-x class="hot-scroll" show-scrollbar="false">
        <view class="hot-row">
          <view v-for="(t, i) in hotTopics" :key="i" class="hot-chip" @click="fillQuestion(t.text)">
            <text>{{ t.text }}</text>
          </view>
        </view>
      </scroll-view>

      <scroll-view scroll-y class="messages" :scroll-top="scrollTop">
        <view v-if="messages.length === 0" class="welcome-panel">
          <text class="welcome-title">👋 你好，我是 Q 智慧顾问</text>
          <text class="welcome-desc">描述你的情感困境，我会给出直线行动方案（匿名提问，不存真实姓名）</text>
          <view class="guide-box">
            <text class="guide-head">怎么用？</text>
            <text v-for="(step, i) in usageSteps" :key="i" class="guide-step">{{ i + 1 }}. {{ step }}</text>
          </view>
          <text class="example-head">试试这些问题（点一下填入输入框）：</text>
          <view class="example-list">
            <view
              v-for="(q, i) in exampleQuestions"
              :key="i"
              class="example-item"
              @click="fillQuestion(q)"
            >
              <text>{{ q }}</text>
            </view>
          </view>
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
          :auto-height="true"
          :show-confirm-bar="false"
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
  </view>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import { getClientId } from '../../utils/clientId.js';
import { formatQuotaText, addStats } from '../../utils/user.js';
import { askChat } from '../../api/chat.js';
import { fetchQuota } from '../../api/quota.js';
import {
  HOT_TOPICS,
  SUCCESS_STORIES,
  USAGE_STEPS,
  EXAMPLE_QUESTIONS,
} from '../../data/constants.js';
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
const usageSteps = USAGE_STEPS;
const exampleQuestions = EXAMPLE_QUESTIONS;
const statusBarPx = ref(20);
const navBarPx = ref(44);
const navTotalPx = ref(64);
let lastQuestion = '';

function initNavBar() {
  const sys = uni.getSystemInfoSync();
  const sb = sys.statusBarHeight || 20;
  statusBarPx.value = sb;
  let bar = 44;
  // #ifdef MP-WEIXIN
  try {
    const menu = uni.getMenuButtonBoundingClientRect();
    if (menu?.height) {
      bar = (menu.top - sb) * 2 + menu.height;
    }
  } catch {
    /* ignore */
  }
  // #endif
  navBarPx.value = bar;
  navTotalPx.value = sb + bar;
}

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
  initNavBar();
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
  initNavBar();
  loadQuota();
  speechOk.value = await checkSpeechAvailable();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  background: #0f0e17;
}

.custom-nav {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 100;
  background: #0f0e17;
  border-bottom: 1rpx solid rgba(108, 92, 231, 0.25);
  box-sizing: border-box;
}

.nav-inner {
  display: flex;
  align-items: center;
  padding: 0 24rpx;
  gap: 16rpx;
}

.nav-logo {
  width: 56rpx;
  height: 56rpx;
  flex-shrink: 0;
}

.nav-text {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
}

.nav-title {
  font-size: 34rpx;
  font-weight: 700;
  color: #f5f5f7;
  line-height: 1.2;
}

.nav-sub {
  font-size: 20rpx;
  color: #a0a0b0;
  line-height: 1.2;
}

.page-body {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 0 24rpx 24rpx;
  box-sizing: border-box;
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
  min-height: 120rpx;
  margin-bottom: 12rpx;
}

.welcome-panel {
  text-align: left;
  padding: 8rpx 4rpx 16rpx;
}

.welcome-title {
  display: block;
  font-size: 30rpx;
  font-weight: 700;
  color: #ff8fa3;
  margin-bottom: 8rpx;
}

.welcome-desc {
  display: block;
  font-size: 24rpx;
  color: #a0a0b0;
  line-height: 1.5;
  margin-bottom: 16rpx;
}

.guide-box {
  background: rgba(108, 92, 231, 0.12);
  border: 1rpx solid rgba(108, 92, 231, 0.35);
  border-radius: 16rpx;
  padding: 16rpx 20rpx;
  margin-bottom: 16rpx;
}

.guide-head,
.example-head {
  display: block;
  font-size: 24rpx;
  font-weight: 600;
  color: #c8c8d8;
  margin-bottom: 10rpx;
}

.guide-step {
  display: block;
  font-size: 24rpx;
  color: #a0a0b0;
  line-height: 1.55;
  margin-bottom: 6rpx;
}

.example-list {
  display: flex;
  flex-direction: column;
  gap: 10rpx;
}

.example-item {
  padding: 14rpx 18rpx;
  background: #242338;
  border-radius: 12rpx;
  border: 1rpx solid rgba(255, 107, 129, 0.35);
  font-size: 24rpx;
  color: #c8c8d8;
  line-height: 1.45;
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
  margin-bottom: 0;
}

.input {
  width: 100%;
  min-height: 88rpx;
  max-height: 200rpx;
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
