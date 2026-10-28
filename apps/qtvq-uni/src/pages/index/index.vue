<template>
  <view class="page" :style="{ height: pageHeightPx + 'px' }">
    <BrandNavBar
      :status-bar-px="statusBarPx"
      :nav-bar-px="navBarPx"
      :nav-total-px="navTotalPx"
      show-brand-center
    />

    <view class="main" :style="{ height: bodyHeightPx + 'px' }">
      <scroll-view v-if="hotTopics.length" scroll-x class="hot-scroll" show-scrollbar="false">
        <view class="hot-row">
          <view v-for="(t, i) in hotTopics" :key="i" class="hot-chip" @tap="fillQuestion(t.text)">
            <text>{{ t.text }}</text>
          </view>
        </view>
      </scroll-view>

      <scroll-view
        v-if="messages.length === 0"
        scroll-y
        class="empty-scroll"
        :style="{ height: emptyScrollPx + 'px' }"
        :show-scrollbar="false"
        enable-back-to-top
      >
        <view class="welcome-panel">
          <text class="welcome-title">👋 你好，我是 Q 智慧顾问</text>
          <text class="welcome-desc">描述你的情感困境，我会给出直线行动方案（匿名提问，不存真实姓名）</text>
          <view class="guide-box">
            <text class="guide-head">怎么用？</text>
            <text v-for="(step, i) in usageSteps" :key="i" class="guide-step">{{ i + 1 }}. {{ step }}</text>
          </view>
        </view>
        <view class="quick-picks card">
          <text class="example-head">试试这些问题（点一下填入输入框）：</text>
          <view
            v-for="(q, i) in exampleQuestions"
            :key="i"
            class="example-item"
            hover-class="example-item-hover"
            @tap.stop="fillQuestion(q)"
          >
            <text class="example-text">{{ q }}</text>
          </view>
        </view>
        <view class="scroll-bottom-spacer" />
      </scroll-view>

      <scroll-view
        v-else
        scroll-y
        class="messages"
        :scroll-top="scrollTop"
        :style="{ height: chatScrollPx + 'px' }"
        enable-back-to-top
      >
        <view
          v-for="(m, i) in messages"
          :key="i"
          :class="['msg', m.role === 'user' ? 'msg-user' : 'msg-ai']"
        >
          <!-- 《人工智能生成合成内容标识办法》：AI 生成内容必须显式标识 -->
          <text v-if="m.role !== 'user'" class="msg-ai-label">本回答由 AI 生成</text>
          <text>{{ m.text }}</text>
          <!--
            危机求助卡片：只在服务端判定 level=urgent 时出现。
            位置在回答**之后** —— 回答照常给，卡片是额外的一条出路，不是替代品。
          -->
          <view v-if="m.support" class="support-card">
            <text class="support-title">{{ m.support.title }}</text>
            <text v-if="m.support.body" class="support-body">{{ m.support.body }}</text>
            <view
              v-for="(r, ri) in m.support.resources"
              :key="ri"
              class="support-item"
              hover-class="support-item-hover"
              @tap="callSupport(r.phone)"
            >
              <text class="support-phone">{{ r.phone }}</text>
              <text class="support-name">{{ r.name }}</text>
              <text v-if="r.note" class="support-note">{{ r.note }}</text>
            </view>
          </view>
          <!--
            第二档：痛苦表述的窄提示条（不是卡片）。
            与 support 互斥；一次启动只显示一条；点「不再提示」永久关闭。
            v-for 的索引 i 参与判断，所以只有被钉住的那条消息会渲染它。
          -->
          <view v-if="m.gentle && i === gentleAt" class="gentle-tip">
            <text class="gentle-text">{{ m.gentle.text }}</text>
            <view class="gentle-row">
              <text class="gentle-phone" @tap="callSupport(m.gentle.primary.phone)">{{ m.gentle.primary.phone }}</text>
              <text v-if="m.gentle.resources && m.gentle.resources.length > 1" class="gentle-more" @tap="gentleOpen = !gentleOpen">
                {{ gentleOpen ? '收起' : '还有别的可以联系' }}
              </text>
              <text class="gentle-close" @tap="dismissGentle">不再提示</text>
            </view>
            <view v-if="gentleOpen" class="gentle-list">
              <text
                v-for="(r, ri) in m.gentle.resources"
                :key="ri"
                class="gentle-item"
                @tap="callSupport(r.phone)"
              >
                {{ r.phone }} {{ r.name }}
              </text>
            </view>
          </view>
        </view>
        <view v-if="loading" class="msg msg-ai">思考中…</view>
        <view class="scroll-bottom-spacer" />
      </scroll-view>

      <scroll-view v-if="stories.length && messages.length" scroll-x class="stories-scroll" show-scrollbar="false">
        <view class="stories-row">
          <view v-for="(s, i) in stories" :key="i" class="story-card" @tap="fillQuestion(s.prompt)">
            <text class="story-tag">{{ s.tag }}</text>
            <text class="story-text">{{ s.text }}</text>
          </view>
        </view>
      </scroll-view>

      <view class="input-area card" id="chat-input-area">
        <textarea
          :key="textareaKey"
          :value="question"
          class="input"
          placeholder="例如：暧昧半年对方不确认关系，我该怎么办？"
          :maxlength="500"
          :auto-height="true"
          :show-confirm-bar="false"
          @input="onQuestionInput"
        />
        <view class="actions">
          <button
            class="btn-secondary voice-btn"
            size="mini"
            hover-class="button-hover"
            :class="{ recording: voiceRecording }"
            @tap="onVoice"
          >
            {{ voiceRecording ? '⏹ 停止' : '🎤 语音' }}
          </button>
          <button class="btn-primary" size="mini" hover-class="button-hover" :disabled="loading" @tap="onAsk">
            获取直线方案
          </button>
          <button
            class="btn-secondary"
            size="mini"
            hover-class="button-hover"
            :disabled="!canFollowUp || loading"
            @tap="onFollowUp"
          >
            再问一步
          </button>
        </view>
        <view class="quota-row">
          <text class="quota">{{ quotaText }}</text>
          <text class="link" @tap="goSubscribe">办理会员</text>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, onMounted, computed, nextTick } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import { getClientId } from '../../utils/clientId.js';
import { formatQuotaText, addStats, applyQuotaToUser } from '../../utils/user.js';
import { askChat } from '../../api/chat.js';
import { track } from '../../utils/track.js';
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
import BrandNavBar from '../../components/BrandNavBar.vue';
import { useNavBar } from '../../utils/navBar.js';

const { statusBarPx, navBarPx, navTotalPx, pageHeightPx, bodyHeightPx, initNavBar } = useNavBar();

const INPUT_AREA_PX = 300;
const HOT_PX = 48;
const STORIES_PX = 92;
const inputAreaPx = ref(INPUT_AREA_PX);

const emptyScrollPx = computed(() => {
  let reserved = inputAreaPx.value + 8;
  if (hotTopics.length) reserved += HOT_PX;
  return Math.max(160, bodyHeightPx.value - reserved);
});

const chatScrollPx = computed(() => {
  let h = bodyHeightPx.value - inputAreaPx.value;
  if (hotTopics.length) h -= HOT_PX;
  if (messages.value.length && stories.length) h -= STORIES_PX;
  return Math.max(160, h);
});
const question = ref('');
const textareaKey = ref(0);
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
let lastQuestion = '';

function measureInputArea() {
  nextTick(() => {
    uni
      .createSelectorQuery()
      .select('#chat-input-area')
      .boundingClientRect((rect) => {
        if (rect?.height) {
          inputAreaPx.value = Math.ceil(rect.height) + 8;
        }
      })
      .exec();
  });
}

async function loadQuota() {
  try {
    const q = await fetchQuota(getClientId());
    applyQuotaToUser(q);
    quotaText.value = formatQuotaText(q);
  } catch {
    quotaText.value = '24 小时内还可提问 5/5 次（离线）';
  }
}

function scrollBottom() {
  scrollTop.value = scrollTop.value === 99999 ? 99998 : 99999;
}

function onQuestionInput(e) {
  question.value = e.detail?.value ?? '';
}

function fillQuestion(text) {
  question.value = text;
  textareaKey.value += 1;
  uni.showToast({ title: '已填入输入框', icon: 'none', duration: 1200 });
}

function goSubscribe() {
  uni.navigateTo({ url: '/pages/subscribe/subscribe' });
}

/**
 * 拨打求助电话。
 *
 * 号码来自服务端（唯一来源在 packages/safety/src/crisis.js），前端不再硬编码，
 * 也不做"这是不是心理热线"的判断 —— 服务端给什么就打什么。
 * makePhoneCall 在小程序里会弹系统确认框，用户可取消，因此要把 fail 静默掉：
 * 用户主动取消不是错误，不该弹红字。
 */
function callSupport(phone) {
  const num = String(phone || '').replace(/[^0-9+]/g, '');
  if (!num) return;
  uni.makePhoneCall({
    phoneNumber: num,
    fail: () => {
      /* 用户取消或环境不支持（如部分模拟器）：复制号码，至少让他能手动拨 */
      uni.setClipboardData({
        data: num,
        success: () => uni.showToast({ title: '号码已复制', icon: 'none' }),
      });
    },
  });
}

/*
 * 第二档窄提示的状态。
 *
 * `gentleAt` 钉住"在哪条消息下展示"，`-1` 表示本启动内不再展示 ——
 * 用索引而不是布尔值，是因为窄条只该出现在**触发它的那条回答**下面；
 * 用布尔值的话刷新消息列表后会跑到最后一条下面，指错上下文。
 * `gentleOff` 从本地读，用户点过「不再提示」就永久不再出现。
 */
const gentleAt = ref(-1);
const gentleOpen = ref(false);
const gentleOff = ref(false);
try {
  gentleOff.value = uni.getStorageSync('qtvq_gentle_tip_off') === '1';
} catch {
  /* 存储不可用：按未关闭处理，最多多出现一次 */
}

function dismissGentle() {
  gentleOff.value = true;
  gentleAt.value = -1;
  gentleOpen.value = false;
  try {
    uni.setStorageSync('qtvq_gentle_tip_off', '1');
  } catch {
    /* 记不住就算了 */
  }
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
    messages.value.push({
      role: 'ai',
      text: data.reply,
      // 危机求助资源（服务端只在 level=urgent 时下发；没有就是 undefined，模板不渲染）
      support: data.support || null,
      // 第二档窄提示（痛苦表述）。与 support 互斥，服务端已保证，这里再挡一次
      gentle: data.support ? null : data.gentle || null,
    });
    /*
     * 窄条一次启动只出现一次：把"展示位置"钉在某一条消息上，
     * 后续就算每条都命中也不会再渲染 —— 频次是这一档能存在的前提，
     * 每问都出现它就成了壁纸（见 packages/safety/src/distress.js 开头）。
     */
    if (data.gentle && !data.support && !gentleOff.value && gentleAt.value < 0) {
      gentleAt.value = messages.value.length - 1;
    }
    /*
     * 激活口径（`server/src/services/metrics.js::ACTIVATION_EVENTS`）：
     * 「完成资料」或「首问」。**只在真的拿到回答之后**报 ——
     * 报在点击时会把限流、配额拦截也算成激活，90 天验收门就失去意义。
     */
    if (!followUp) track('question_asked', { mode: 'mp' });
    addStats(data.qCoins || 0, data.wisdom || 0, 5);
    canFollowUp.value = true;
    if (data.quota) {
      applyQuotaToUser(data.quota);
      quotaText.value = formatQuotaText(data.quota);
    }
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
        textareaKey.value += 1;
        uni.showToast({ title: '已识别并填入', icon: 'none' });
      } else {
        uni.showToast({ title: '未识别到语音，请说清楚一些', icon: 'none' });
      }
    } catch (e) {
      const msg = e.data?.message || e.message || '语音识别失败';
      uni.showToast({ title: msg, icon: 'none', duration: 2500 });
    } finally {
      uni.hideLoading();
    }
    return;
  }
  try {
    await startRecording();
    voiceRecording.value = true;
    uni.showToast({ title: '正在录音，再点停止', icon: 'none' });
  } catch (e) {
    /*
     * 隐私授权被拒必须与"麦克风不可用"分开讲。
     * 原来一并 toast「无法访问麦克风」，用户会去系统设置里找麦克风权限 ——
     * 但真正要开的是小程序内的《隐私保护指引》，在系统里永远找不到，等于死路。
     */
    if (e?.code === 'PRIVACY_DENIED') {
      uni.showModal({
        title: '需要先同意隐私指引',
        content:
          '语音输入会用麦克风，需先同意《隐私保护指引》。请退出后重新进入小程序，在弹窗中点「允许」；若此前点过「拒绝」，可在右上角「···」→「设置」中重新开启。',
        showCancel: false,
      });
      return;
    }
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
  measureInputArea();
  loadQuota();
  speechOk.value = await checkSpeechAvailable();
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

.main {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 0 24rpx 16rpx;
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
  background: $color-bg-elevated;
  border-radius: 999rpx;
  font-size: 22rpx;
  color: $color-text-soft;
  max-width: 420rpx;
  overflow: hidden;
  text-overflow: ellipsis;
}

.story-card {
  display: inline-flex;
  flex-direction: column;
  width: 320rpx;
  padding: 16rpx;
  background: $color-bg-elevated;
  border-radius: 16rpx;
  border: 1rpx solid rgba(108, 92, 231, 0.35);
}

.story-tag {
  font-size: 20rpx;
  color: $color-purple;
  margin-bottom: 8rpx;
}

.story-text {
  font-size: 22rpx;
  color: $color-text-muted;
  white-space: normal;
  line-height: 1.4;
}

.empty-scroll,
.messages {
  width: 100%;
  flex-shrink: 0;
}

.scroll-bottom-spacer {
  height: 16rpx;
  padding-bottom: env(safe-area-inset-bottom);
}

.welcome-panel {
  text-align: left;
  padding: 8rpx 4rpx 16rpx;
}

.welcome-title {
  display: block;
  font-size: 30rpx;
  font-weight: 700;
  color: $color-pink-light;
  margin-bottom: 8rpx;
}

.welcome-desc {
  display: block;
  font-size: 24rpx;
  color: $color-text-muted;
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
  color: $color-text-soft;
  margin-bottom: 10rpx;
}

.guide-step {
  display: block;
  font-size: 24rpx;
  color: $color-text-muted;
  line-height: 1.55;
  margin-bottom: 6rpx;
}

.example-list {
  display: flex;
  flex-direction: column;
  gap: 10rpx;
}

.quick-picks {
  margin-top: 12rpx;
  margin-bottom: 0;
  box-sizing: border-box;
}

.example-item {
  padding: 18rpx 20rpx;
  background: $color-bg-elevated;
  border-radius: 12rpx;
  border: 1rpx solid rgba(255, 107, 129, 0.35);
  margin-bottom: 12rpx;
}

.example-item:last-child {
  margin-bottom: 0;
}

.example-item-hover {
  background: rgba(255, 107, 129, 0.15);
}

.example-text {
  font-size: 26rpx;
  color: $color-text-bright;
  line-height: 1.5;
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
  background: linear-gradient(135deg, $color-pink, $color-purple);
  color: #fff;
}

.msg-ai {
  background: $color-bg-elevated;
  border-left: 6rpx solid $color-purple;
}

.input-area {
  flex-shrink: 0;
  margin-bottom: 0;
}

.input {
  width: 100%;
  min-height: 88rpx;
  max-height: 200rpx;
  background: $color-bg;
  border: 1rpx solid rgba(108, 92, 231, 0.4);
  border-radius: 16rpx;
  padding: 16rpx;
  color: $color-text;
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
  color: $color-pink;
  border-color: $color-pink;
}

.quota-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 12rpx;
}

.quota {
  font-size: 22rpx;
  color: $color-text-muted;
}

.button-hover {
  opacity: 0.85;
}

.link {
  font-size: 22rpx;
  color: $color-purple;
  padding: 8rpx 0;
}
  /* AI 生成内容显式标识（《人工智能生成合成内容标识办法》），与官网 .msg-ai-label 同一语义 */
  .msg-ai-label {
    display: block;
    font-size: 22rpx;
    line-height: 1.4;
    color: $color-text-dim;
    margin-bottom: 10rpx;
    letter-spacing: 0.02em;
  }

  /*
   * 危机求助卡片。与官网 `.support-card` 同一视觉语义（低饱和暖色边框，
   * 不做成警报样式 —— 一个人说「我不想活了」时，红色感叹号式的界面像在审判他）。
   * 小程序不能直接复用 CSS，所以数值在这里再写一遍；改配色时两处都要动，
   * `check-safety-wiring.mjs` 会比对两边的号码来源而不比对样式，这是有意的取舍。
   */
  .support-card {
    margin-top: 20rpx;
    padding: 24rpx;
    border: 1rpx solid rgba(255, 138, 138, 0.32);
    border-radius: $radius-md;
    background: rgba(255, 138, 138, 0.06);
  }

  .support-title {
    display: block;
    font-size: 28rpx;
    font-weight: 600;
    line-height: 1.5;
    color: $color-text-bright;
    margin-bottom: 12rpx;
  }

  .support-body {
    display: block;
    font-size: 24rpx;
    line-height: 1.75;
    color: $color-text-soft;
    margin-bottom: 16rpx;
  }

  .support-item {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    padding: 10rpx 0;
  }

  .support-item-hover {
    opacity: 0.7;
  }

  .support-phone {
    font-size: 34rpx;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: $color-success-bright;
    margin-right: 12rpx;
  }

  .support-name {
    font-size: 24rpx;
    color: $color-text-muted;
    margin-right: 12rpx;
  }

  .support-note {
    font-size: 22rpx;
    color: $color-text-faint;
  }

  /*
   * 第二档窄提示（痛苦表述）。与 card 的区别全在"重量"：
   * 单行、细边、冷色，不遮挡回答；用户点「不再提示」永久关闭。
   * 如果哪天需要"更显眼才能被看到"，说明判定太宽了 —— 应该收窄判定，不是加粗样式。
   */
  .gentle-tip {
    margin-top: 16rpx;
    padding: 16rpx 18rpx;
    border-left: 6rpx solid rgba(120, 170, 220, 0.45);
    border-radius: $radius-sm;
    background: rgba(120, 170, 220, 0.06);
  }

  .gentle-text {
    display: block;
    font-size: 24rpx;
    line-height: 1.6;
    color: $color-text-soft;
  }

  .gentle-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    margin-top: 10rpx;
  }

  .gentle-phone {
    font-size: 30rpx;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: $color-text-bright;
    margin-right: 20rpx;
  }

  .gentle-more {
    font-size: 22rpx;
    color: $color-text-muted;
    text-decoration: underline;
    margin-right: 20rpx;
  }

  .gentle-close {
    font-size: 22rpx;
    color: $color-text-faint;
    margin-left: auto;
  }

  .gentle-list {
    margin-top: 8rpx;
  }

  .gentle-item {
    display: block;
    font-size: 22rpx;
    color: $color-text-muted;
    padding: 6rpx 0;
  }
</style>
