<template>
  <view class="page">
    <!-- 生成新报告 -->
    <view class="card">
      <text class="title">配对报告</text>
      <text class="hint">选一位对象 + 档位，生成一份「避坑 + 直线解决」式配对分析。分数由算法确定性算出，正文由 AI 写。</text>

      <view v-if="needsProfile" class="notice warn">
        <text>需要先完善自己的资料（昵称 + 性别），报告才能算得准。</text>
        <button size="mini" class="btn" @tap="goProfile">去填资料</button>
      </view>

      <template v-else>
        <text class="label">① 选择对象</text>
        <scroll-view scroll-x class="target-scroll">
          <view
            v-for="c in candidates"
            :key="c.uid"
            :class="['target-chip', targetUid === c.uid ? 'active' : '']"
            @tap="targetUid = c.uid"
          >
            <text class="chip-name">{{ c.nickname || '（未公开）' }}</text>
            <text class="chip-meta">{{ c.gender === 'female' ? '女' : c.gender === 'male' ? '男' : '' }}<text v-if="c.city"> · {{ c.city }}</text></text>
          </view>
          <view v-if="candidates.length === 0" class="notice warn"><text>还没有可分析的对象：生成邀请链接发给朋友，对方填资料后就会出现。</text></view>
        </scroll-view>

        <text class="label">② 选择档位</text>
        <view class="tier-row">
          <view
            v-for="t in tiers"
            :key="t.key"
            :class="['tier-chip', tier === t.key ? 'active' : '']"
            @tap="tier = t.key"
          >
            <text class="tier-zh">{{ t.zh }}</text>
            <text class="tier-price">{{ t.price > 0 ? '¥' + t.price : '免费' }}</text>
          </view>
        </view>

        <text class="label">③ 你想问什么（选填）</text>
        <input v-model="question" class="input" maxlength="200" placeholder="例如：我们要不要继续下去？" />

        <button class="btn-primary" :disabled="generating || !targetUid" @tap="generate">
          {{ generating ? '生成中（约 10–30 秒）…' : '生成报告 ' + tierLabel }}
        </button>
        <text v-if="errorText" class="error">{{ errorText }}</text>
      </template>
    </view>

    <!-- 报告正文 -->
    <view v-if="report" class="card">
      <text class="title">报告结果 · {{ report.tierZh || '' }}</text>
      <view class="score-row">
        <text class="score-num">{{ report.overall ?? '—' }}</text>
        <text class="score-label">综合契合度</text>
      </view>
      <view v-if="report.labels?.length" class="label-row">
        <text v-for="(l, i) in report.labels" :key="i" class="pill">{{ l }}</text>
      </view>
      <view v-if="scoreList.length" class="dims">
        <view v-for="d in scoreList" :key="d.k" class="dim">
          <text class="dim-k">{{ d.k }}</text>
          <view class="dim-bar"><view class="dim-fill" :style="{ width: d.v + '%' }" /></view>
          <text class="dim-v">{{ d.v }}</text>
        </view>
      </view>
      <text v-if="report.fallback" class="notice warn">AI 暂时不可用，本报告由规则与案例库生成（内容仍然可用）。</text>
      <text class="content">{{ report.content }}</text>
      <text v-if="report.billing" class="billing">
        本次扣除 {{ report.billing.charged > 0 ? '¥' + report.billing.charged : '免费' }}
        <text v-if="typeof report.billing.balance === 'number'"> · 余额 ¥{{ report.billing.balance.toFixed(2) }}</text>
        <text v-if="report.billing.replayed"> ·（重复提交，未二次扣费）</text>
      </text>
      <view class="actions">
        <button size="mini" class="btn" @tap="shareReport">生成分享链接</button>
        <button size="mini" class="btn" @tap="copyContent">复制正文</button>
        <button size="mini" class="btn" @tap="goAbuse">举报对象</button>
        <button size="mini" class="btn" @tap="report = null">收起</button>
      </view>
    </view>

    <!-- 我的报告 -->
    <view class="card">
      <text class="section-title">我的报告</text>
      <view v-if="mine.length === 0"><text class="hint">还没有报告</text></view>
      <view v-for="r in mine" :key="r.id" class="mine-item" @tap="openReport(r.id)">
        <view class="mine-main">
          <text class="mine-title">{{ r.targetSnapshot?.nickname || '（未公开）' }} · {{ r.tierZh || '' }}</text>
          <text class="mine-meta">契合度 {{ r.overall ?? '—' }} · {{ formatTime(r.createdAt) }}</text>
        </view>
        <text class="arrow">›</text>
      </view>
    </view>

    <!-- 邀请 -->
    <view class="card">
      <text class="section-title">邀请好友（扩充候选池）</text>
      <text class="hint">朋友填完资料后会进入候选池，你和别人都能转到他/她。</text>
      <button size="mini" class="btn" @tap="createInvite">生成邀请链接</button>
    </view>

    <!-- 18+ 年龄门（生成报告前挡一次；服务端 /generate 仍会二次校验） -->
    <AdultGate ref="adultGate" />
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { generateReport, fetchMyReports, fetchReport, shareReport as apiShare, createInvite as apiInvite } from '../../api/report.js';
import { fetchWheelCandidates } from '../../api/wheel.js';
import { fetchWallet } from '../../api/wallet.js';
import AdultGate from '../../components/AdultGate.vue';
import { ensureAdult } from '../../utils/adult.js';
import { track } from '../../utils/track.js';
import { needQuotaHint } from '../../utils/platform.js';

const NEED_QUOTA_HINT = needQuotaHint();
const adultGate = ref(null);

const candidates = ref([]);
const needsProfile = ref(false);
const tiers = ref([{ key: 'basic', zh: '缘分一转', price: 1 }]);
const tier = ref('basic');
const question = ref('');
const targetUid = ref('');
const generating = ref(false);
const errorText = ref('');
const report = ref(null);
const mine = ref([]);

const tierLabel = computed(() => {
  const t = tiers.value.find((x) => x.key === tier.value);
  return t ? `${t.zh}${t.price > 0 ? ' ¥' + t.price : ''}` : '';
});

const scoreList = computed(() => {
  const s = report.value?.scores;
  if (!s || typeof s !== 'object') return [];
  return Object.entries(s)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => ({ k, v: Math.max(0, Math.min(100, Math.round(v))) }));
});

async function load() {
  try {
    const [cand, w, m] = await Promise.all([
      fetchWheelCandidates().catch(() => ({ items: [] })),
      fetchWallet().catch(() => null),
      fetchMyReports(20).catch(() => ({ items: [] })),
    ]);
    candidates.value = cand.items || [];
    needsProfile.value = !!cand.needsProfile;
    if (cand.items?.length) targetUid.value = cand.items[0].uid;
    const wt = w?.tiers || w?.wallet?.tiers;
    if (Array.isArray(wt) && wt.length) tiers.value = wt;
    mine.value = m.items || [];
  } catch (e) {
    errorText.value = e?.message || '';
  }
}

/**
 * 报告「生成成功」的唯一埋点出口。
 *
 * 口径：营收唯一真相是服务端 `orders` 集合，`report_paid` 只表示
 * 「客户端确实看到一次扣费成功」，用于支付/转化漏斗，与看板营收**不叠加**。
 * 所以只在生成成功、且 `billing.charged > 0`、且非幂等重放时才报 ——
 * 点击时就报会把被余额/配额拦下的请求也算成付费。
 */
function trackReportOutcome(rep) {
  const billing = rep?.billing || {};
  const base = { tier: rep?.tier || tier.value, sku: rep?.sku || 'pair', page: 'mp-report' };
  try {
    track('report_generated', base);
    const charged = Number(billing.charged) || 0;
    if (charged > 0 && !billing.replayed) {
      track('report_paid', {
        ...base,
        charged,
        amount: Number(billing.amount) || charged,
        plan_label: billing.label || null,
      });
    }
  } catch {
    /* 埋点永不打断主流程 */
  }
}

async function generate() {
  if (!targetUid.value) return;

  /*
   * 年龄门挡在**发请求之前**：先生成再拦，用户已经等了一次 10–30 秒的生成，
   * 结果告诉他"要先填出生年份"—— 体验与合规两头都输。
   * 未登录时 ensureAdult 直接放行（交给登录流程），服务端仍 403 兜底。
   */
  const adultOk = await ensureAdult(adultGate, '生成配对报告');
  if (!adultOk) return;

  generating.value = true;
  errorText.value = '';
  report.value = null;
  try {
    track('report_pay_intent', { tier: tier.value, price: currentPrice() });
    const data = await generateReport({
      targetUid: targetUid.value,
      tier: tier.value,
      question: question.value,
      // 幂等键：同一次点击重复提交不会二次扣费
      idempotencyKey: `${targetUid.value}-${tier.value}-${Date.now()}`,
    });
    report.value = data.report || data;
    trackReportOutcome(report.value);
    fetchMyReports(20).then((m) => {
      mine.value = m.items || [];
    });
  } catch (e) {
    if (e?.code === 'E_NEED_BIRTHYEAR' || e?.code === 'E_UNDERAGE') {
      // 服务端侧门没过（例如换了设备、承诺版本升级）：直接弹门，不要让用户猜
      await ensureAdult(adultGate, '生成配对报告');
      errorText.value = e?.message || '需要先完成成年用户确认';
    } else if (e?.code === 'E_INSUFFICIENT_BALANCE') {
      errorText.value = `${e.message}${NEED_QUOTA_HINT}`;
    } else {
      errorText.value = e?.message || '生成失败，请稍后再试';
    }
  } finally {
    generating.value = false;
  }
}

/** 当前选中档位的价格（只用于埋点分析，真实扣费以服务端为准） */
function currentPrice() {
  const t = tiers.value.find((x) => x.key === tier.value);
  return typeof t?.price === 'number' ? t.price : null;
}

async function openReport(id) {
  try {
    const data = await fetchReport(id);
    report.value = data.report || data;
    uni.pageScrollTo({ scrollTop: 0, duration: 200 });
  } catch (e) {
    errorText.value = e?.message || '读取失败';
  }
}

async function shareReport() {
  const id = report.value?.id || report.value?.reportId;
  if (!id) return;
  try {
    const data = await apiShare(id);
    const token = data.shareToken || data.token;
    const url = token ? `https://qtvq.cn/report.html?id=${id}&share=${token}` : `https://qtvq.cn/report.html?id=${id}`;
    uni.setClipboardData({ data: url, success: () => uni.showToast({ title: '分享链接已复制', icon: 'none' }) });
  } catch (e) {
    errorText.value = e?.message || '分享失败';
  }
}

function copyContent() {
  const text = report.value?.content || '';
  if (!text) return;
  uni.setClipboardData({ data: text, success: () => uni.showToast({ title: '正文已复制', icon: 'none' }) });
}

async function createInvite() {
  try {
    const data = await apiInvite();
    const token = data.token || data.inviteToken;
    const url = token ? `https://qtvq.cn/report.html?invite=${token}` : 'https://qtvq.cn';
    uni.setClipboardData({ data: url, success: () => uni.showToast({ title: '邀请链接已复制', icon: 'none' }) });
  } catch (e) {
    errorText.value = e?.message || '生成邀请链接失败';
  }
}

function goProfile() {
  uni.switchTab({ url: '/pages/profile/profile' });
}

/** 举报报告里的对象 */
function goAbuse() {
  const t = report.value?.target || report.value?.targetSnapshot;
  if (!t?.uid) {
    // 报告里没有对象 uid 时（老数据/分享报告）不能静默失败，要告诉用户原因
    uni.showToast({ title: '这份报告没有可举报的对象资料', icon: 'none' });
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

onMounted(() => {
  // 报告漏斗的第一格（与官网 js/report.js 同名事件，两端可合并统计）
  track('report_landing_view', { page: 'mp-report' });
  load();
});
</script>

<style lang="scss">
.page { padding: 24rpx; background: $color-bg-deep; min-height: 100vh; }
.card { background: $color-bg-sunken; border-radius: 16rpx; padding: 24rpx; margin-bottom: 24rpx; }
.title { font-size: 34rpx; font-weight: 600; color: #fff; display: block; }
.section-title { font-size: 28rpx; color: #fff; display: block; margin-bottom: 12rpx; }
.hint { font-size: 24rpx; color: $color-text-dim; display: block; margin: 10rpx 0 16rpx; line-height: 1.6; }
.label { font-size: 26rpx; color: $color-text-softer; display: block; margin: 16rpx 0 10rpx; }
.notice { padding: 18rpx; border-radius: 12rpx; margin: 12rpx 0; }
.notice.warn { background: rgba(255, 176, 32, 0.12); border: 1px solid rgba(255, 176, 32, 0.3); }
.notice.warn text { font-size: 24rpx; color: $color-warning; line-height: 1.6; }
.target-scroll { white-space: nowrap; }
.target-chip { display: inline-block; padding: 14rpx 20rpx; border-radius: 12rpx; background: $color-bg-deep; margin-right: 12rpx; }
.target-chip.active { background: rgba(255, 107, 129, 0.18); border: 1rpx solid $color-pink; }
.chip-name { font-size: 26rpx; color: $color-text-bright; display: block; }
.chip-meta { font-size: 22rpx; color: $color-text-dim; }
.tier-row { display: flex; flex-wrap: wrap; gap: 12rpx; }
.tier-chip { padding: 14rpx 20rpx; border-radius: 12rpx; background: $color-bg-deep; text-align: center; }
.tier-chip.active { background: rgba(255, 107, 129, 0.18); border: 1rpx solid $color-pink; }
.tier-zh { font-size: 26rpx; color: $color-text-bright; display: block; }
.tier-price { font-size: 22rpx; color: $color-pink-soft; }
.input { background: $color-bg-deep; color: $color-text-bright; border-radius: 10rpx; padding: 16rpx 20rpx; font-size: 26rpx; }
.btn-primary { background: $color-pink; color: #fff; border-radius: 999rpx; margin-top: 20rpx; }
.btn { margin: 8rpx 8rpx 0 0; background: $color-bg-deep; color: $color-text-softer; border-radius: 999rpx; }
.error { color: $color-danger-soft; font-size: 24rpx; display: block; margin-top: 14rpx; line-height: 1.6; }
.score-row { display: flex; align-items: baseline; gap: 12rpx; margin: 12rpx 0; }
.score-num { font-size: 56rpx; color: $color-pink; font-weight: 700; }
.score-label { font-size: 24rpx; color: $color-text-dim; }
.label-row { display: flex; flex-wrap: wrap; gap: 10rpx; margin-bottom: 12rpx; }
.pill { font-size: 22rpx; color: $color-pink-soft; background: rgba(255, 107, 129, 0.12); padding: 6rpx 14rpx; border-radius: 999rpx; }
.dims { margin: 12rpx 0; }
.dim { display: flex; align-items: center; gap: 12rpx; margin-bottom: 8rpx; }
.dim-k { width: 120rpx; font-size: 22rpx; color: $color-text-dim; }
.dim-bar { flex: 1; height: 10rpx; background: $color-bg-deep; border-radius: 999rpx; overflow: hidden; }
.dim-fill { height: 10rpx; background: $color-pink; }
.dim-v { width: 50rpx; font-size: 22rpx; color: $color-text-dim; text-align: right; }
.content { font-size: 27rpx; color: $color-text-bright; line-height: 1.8; display: block; margin-top: 12rpx; white-space: pre-wrap; }
.billing { font-size: 22rpx; color: $color-text-dim; display: block; margin-top: 12rpx; }
.actions { margin-top: 16rpx; }
.mine-item { display: flex; justify-content: space-between; align-items: center; padding: 18rpx 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
.mine-title { font-size: 26rpx; color: $color-text-bright; display: block; }
.mine-meta { font-size: 22rpx; color: $color-text-dim; }
.arrow { color: $color-text-dim; font-size: 32rpx; }
</style>
