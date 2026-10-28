<template>
  <view class="page">
    <view class="card">
      <text class="title">转盘配对</text>
      <text class="hint">从真实的异性别用户里转出一位；每次 {{ quoteLabel }}</text>

      <view v-if="needsProfile" class="notice warn">
        <text>转盘需要先知道你的性别才能只出异性。请先到「缘值」页填写资料（昵称 + 性别即可）。</text>
        <button class="btn" size="mini" @click="goProfile">去填资料</button>
      </view>

      <view v-else-if="empty" class="notice warn">
        <text>{{ emptyHint }}</text>
        <button class="btn" size="mini" @click="goProfile">生成邀请链接</button>
      </view>

      <template v-else>
        <canvas
          canvas-id="wheelCanvas"
          id="wheelCanvas"
          class="wheel-canvas"
          :style="{ width: canvasSize + 'px', height: canvasSize + 'px' }"
        />
        <button class="btn-primary" :disabled="spinning || loading" @click="doSpin">
          {{ spinning ? '转动中…' : '转一圈 ' + quoteLabel }}
        </button>
      </template>

      <view v-if="result" class="result">
        <text class="result-title">🎯 转到：{{ result.target?.nickname || '（未公开昵称）' }}</text>
        <text class="result-line">
          {{ result.target?.gender === 'female' ? '女生' : result.target?.gender === 'male' ? '男生' : '' }}
          <text v-if="result.target?.age"> · {{ result.target.age }} 岁</text>
          <text v-if="result.target?.city"> · {{ result.target.city }}</text>
        </text>
        <text v-if="result.target?.tags?.length" class="result-line">标签：{{ (result.target.tags || []).join(' / ') }}</text>
        <text v-if="result.target?.intro" class="result-line intro">{{ result.target.intro }}</text>
        <text class="result-line billing">
          本次扣除 {{ result.billing?.charged > 0 ? '¥' + result.billing.charged : '免费' }}
          <text v-if="typeof result.billing?.balance === 'number'"> · 余额 ¥{{ result.billing.balance.toFixed(2) }}</text>
        </text>
        <button class="btn" size="mini" @click="goReport">生成配对报告</button>
        <button class="btn" size="mini" @click="goAbuse">举报此人</button>
      </view>

      <text v-if="errorText" class="error">{{ errorText }}</text>
    </view>

    <view class="card">
      <text class="section-title">最近转动</text>
      <view v-if="history.length === 0">
        <text class="hint">还没有产生过转盘记录 —— 转盘只有在有<text class="strong">可配对用户</text>时才会真正转动并留下记录（没有任何人可配对时，转动不会发生，也不会记录）。</text>
      </view>
      <view v-for="(h, i) in history" :key="i" class="history-item">
        <text>{{ h.target?.nickname || '（未公开）' }}</text>
        <text class="history-meta">
          {{ h.billing?.charged > 0 ? '¥' + h.billing.charged : '免费' }}
          · {{ formatTime(h.createdAt) }}
        </text>
      </view>
    </view>

    <!-- 18+ 年龄门（转盘会扣缘值，属于付费动作；服务端 /wheel/spin 仍会二次校验） -->
    <AdultGate ref="adultGate" />
  </view>
</template>

<script setup>
import { ref, onMounted, getCurrentInstance } from 'vue';
import AdultGate from '../../components/AdultGate.vue';
import { ensureAdult } from '../../utils/adult.js';
import { track } from '../../utils/track.js';
import { fetchWheelCandidates, fetchWheelQuote, spinWheel, fetchSpinHistory } from '../../api/wheel.js';
import { needQuotaHint } from '../../utils/platform.js';

const NEED_QUOTA_HINT = needQuotaHint();
const canvasSize = 280;
const loading = ref(true);
const spinning = ref(false);
const needsProfile = ref(false);
const empty = ref(false);
const emptyHint = ref('');
const quoteLabel = ref('¥1');
const price = ref(1);
const sectors = ref([]);
const result = ref(null);
const history = ref([]);
const errorText = ref('');
const adultGate = ref(null);
let rotation = 0;

const inst = getCurrentInstance();

function draw(rot = 0, highlight = -1) {
  // uni.createCanvasContext 的第二个参数需要**组件实例代理**（getCurrentInstance().proxy），
  // 直接传 getCurrentInstance() 的返回值在小程序端可能拿不到正确的 canvas。
  const ctx = uni.createCanvasContext('wheelCanvas', inst?.proxy ?? inst);
  const r = canvasSize / 2;
  const n = Math.max(sectors.value.length, 1);
  const arc = (Math.PI * 2) / n;
  ctx.clearRect(0, 0, canvasSize, canvasSize);
  sectors.value.forEach((s, i) => {
    const start = rot + i * arc;
    ctx.beginPath();
    ctx.moveTo(r, r);
    ctx.arc(r, r, r - 6, start, start + arc);
    // canvas 里拿不到 SCSS 变量，这三个值必须与 packages/tokens 逐字一致：
    // #ff6b81 = pink / #2a2940 = bgRaised / #1c1c28 = bgSunken
    // （原来是 #2a2a3d 与 #232333 —— 主站没有这两个值，属于小程序独有的"野色"）
    ctx.setFillStyle(highlight === i ? '#ff6b81' : i % 2 ? '#2a2940' : '#1c1c28');
    ctx.fill();
    // 昵称（取前 3 个字，避免扇形里挤满字）
    const mid = start + arc / 2;
    ctx.setFillStyle('#e8e8f0');
    ctx.setFontSize(11);
    ctx.fillText(String(s.nickname || '—').slice(0, 3), r + Math.cos(mid) * r * 0.62 - 8, r + Math.sin(mid) * r * 0.62 + 4);
  });
  ctx.setFillStyle('#ff6b81');
  ctx.beginPath();
  ctx.arc(r, r, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.draw();
}

function animateTo(targetIndex) {
  return new Promise((resolve) => {
    const n = Math.max(sectors.value.length, 1);
    const arc = (Math.PI * 2) / n;
    // 让目标扇区停到指针（正上方）位置；多转 4 圈保证"看得见转动"
    const target = Math.PI * 2 * 4 + (Math.PI * 1.5 - (targetIndex * arc + arc / 2));
    const from = rotation % (Math.PI * 2);
    const delta = target - from;
    const t0 = Date.now();
    const dur = 2200;
    const tick = () => {
      const k = Math.min((Date.now() - t0) / dur, 1);
      const ease = 1 - Math.pow(1 - k, 4); // 与 Web 端同一缓动
      rotation = from + delta * ease;
      draw(-rotation, k === 1 ? targetIndex : -1);
      if (k < 1) setTimeout(tick, 16);
      else resolve();
    };
    tick();
  });
}

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    const [cand, q, hist] = await Promise.all([
      fetchWheelCandidates(),
      fetchWheelQuote().catch(() => ({ amount: 1, label: '每次 ¥1' })),
      fetchSpinHistory(10).catch(() => ({ items: [] })),
    ]);
    needsProfile.value = !!cand.needsProfile;
    empty.value = !!cand.empty;
    emptyHint.value = `${cand.hint || '还没有可配对的用户。可以先生成邀请链接发给朋友。'}\n本次不会真正转动，因此**不计入**免费次数、也不会产生转盘记录。`;
    sectors.value = cand.items || [];
    price.value = Number(q.amount ?? q.price ?? 1);
    quoteLabel.value = price.value > 0 ? `¥${price.value}` : '免费';
    history.value = hist.items || [];
    if (!needsProfile.value && !empty.value) draw(-rotation);
  } catch (e) {
    errorText.value = e?.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

async function doSpin() {
  if (spinning.value) return;

  // 转盘会扣缘值：先过年龄门，再动钱（服务端 /wheel/spin 仍会二次校验）
  const adultOk = await ensureAdult(adultGate, '转盘抽奖');
  if (!adultOk) return;

  spinning.value = true;
  errorText.value = '';
  result.value = null;
  try {
    const data = await spinWheel();
    if (data.targetIndex == null) {
      // 候选池为空的"成功但无结果"情形：后端会返回 hint
      empty.value = true;
      emptyHint.value = data.hint || emptyHint.value;
      return;
    }
    await animateTo(data.targetIndex);
    result.value = data;
    /*
     * 事件名必须写成字面量：`check-activation-wiring.mjs` 与看板都靠字面量匹配，
     * `track(x > 0 ? 'a' : 'b')` 这种写法在静态扫描里等于没上报（踩过一次）。
     */
    if (data.billing?.charged > 0) {
      track('wheel_spin_paid', { tier: data.tier || null, charged: data.billing.charged });
    } else {
      track('wheel_spin_free', { tier: data.tier || null });
    }
    fetchSpinHistory(10).then((h) => {
      history.value = h.items || [];
    });
  } catch (e) {
    if (e?.code === 'E_NEED_BIRTHYEAR' || e?.code === 'E_UNDERAGE') {
      await ensureAdult(adultGate, '转盘抽奖');
      errorText.value = e?.message || '需要先完成成年用户确认';
    } else if (e?.code === 'E_INSUFFICIENT_BALANCE') {
      errorText.value = `${e.message}${NEED_QUOTA_HINT}`;
    } else if (e?.code === 'E_NEED_PROFILE') {
      needsProfile.value = true;
      errorText.value = e.message || '请先完善资料';
    } else {
      errorText.value = e.message || '转动失败，请稍后再试';
    }
  } finally {
    spinning.value = false;
  }
}

function goProfile() {
  uni.switchTab({ url: '/pages/profile/profile' });
}

function goReport() {
  // 转出结果后直接去报告页（同一批候选、同一套资料，是最自然的下一步）
  uni.navigateTo({ url: '/pages/report/report' });
}

/** 举报当前转到的对象（带上 uid 与昵称，举报页无需再选人） */
function goAbuse() {
  const t = result.value?.target;
  if (!t?.uid) {
    // 静默 return 会让用户以为按钮坏了；给一句明确提示
    uni.showToast({ title: '请先转一次，拿到对象后再举报', icon: 'none' });
    return;
  }
  uni.navigateTo({
    url: `/pages/abuse/abuse?uid=${encodeURIComponent(t.uid)}&name=${encodeURIComponent(t.nickname || '')}`,
  });
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

onMounted(load);
</script>

<style lang="scss">
.page { padding: 24rpx; background: $color-bg-deep; min-height: 100vh; }
.card { background: $color-bg-sunken; border-radius: 16rpx; padding: 24rpx; margin-bottom: 24rpx; }
.title { font-size: 34rpx; font-weight: 600; color: #fff; display: block; }
.section-title { font-size: 28rpx; color: #fff; display: block; margin-bottom: 12rpx; }
.hint { font-size: 24rpx; color: $color-text-dim; display: block; margin: 10rpx 0 16rpx; }
.notice { padding: 20rpx; border-radius: 12rpx; margin-bottom: 16rpx; }
.notice.warn { background: rgba(255, 176, 32, 0.12); border: 1px solid rgba(255, 176, 32, 0.3); }
.wheel-canvas { margin: 20rpx auto; display: block; }
.btn-primary { background: $color-pink; color: #fff; border-radius: 999rpx; margin-top: 16rpx; }
.btn { margin-top: 16rpx; }
.result { margin-top: 24rpx; padding: 20rpx; border-radius: 12rpx; background: rgba(255, 107, 129, 0.1); }
.result-title { font-size: 30rpx; color: $color-pink-soft; display: block; margin-bottom: 10rpx; }
.result-line { font-size: 24rpx; color: $color-text-softer; display: block; line-height: 1.6; }
.result-line.intro { color: $color-text-dim; }
.result-line.billing { color: $color-text-dim; margin-top: 8rpx; }
.error { color: $color-danger-soft; font-size: 24rpx; display: block; margin-top: 16rpx; line-height: 1.6; }
.history-item { display: flex; justify-content: space-between; padding: 14rpx 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
.history-meta { font-size: 22rpx; color: $color-text-dim; }
</style>
