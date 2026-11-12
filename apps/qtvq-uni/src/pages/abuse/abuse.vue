<template>
  <view class="page">
    <view class="card">
      <text class="title">举报</text>
      <text class="hint">
        举报会提交给运营人工审核。请描述具体问题（涉黄赌毒诈、引流、骚扰等），
        我们会核实并处理；恶意举报也会被记录。
      </text>

      <view v-if="targetName" class="target">
        <text class="target-label">举报对象</text>
        <text class="target-name">{{ targetName }}</text>
      </view>

      <text class="label">举报原因（必选）</text>
      <view class="reasons">
        <view
          v-for="r in reasons"
          :key="r"
          :class="['reason-chip', reason === r ? 'active' : '']"
          @tap="reason = r"
        >
          <text>{{ r }}</text>
        </view>
      </view>

      <text class="label">补充说明（选填，最多 500 字）</text>
      <textarea
        v-model="detail"
        class="textarea"
        maxlength="500"
        placeholder="例如：对方在资料里留联系方式引导站外加好友"
      />
      <text class="counter">{{ detail.length }}/500</text>

      <button class="btn-primary" :disabled="submitting || !reason" @tap="submit">
        {{ submitting ? '提交中…' : '提交举报' }}
      </button>
      <text class="hint">举报会提交给运营人工核实；同一对象当天只能举报一次。恶意举报会被记录。</text>
      <text v-if="msg" :class="['msg', ok ? 'ok' : 'bad']">{{ msg }}</text>
    </view>

    <view class="card">
      <text class="section-title">我的举报记录</text>
      <view v-if="mine.length === 0"><text class="hint">还没有举报记录</text></view>
      <view v-for="(m, i) in mine" :key="i" class="mine-item">
        <view class="mine-main">
          <text class="mine-reason">{{ m.reason || '—' }}</text>
          <text class="mine-meta">{{ statusText(m.status) }} · {{ formatTime(m.createdAt) }}</text>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { submitReport, fetchMyReports, REPORT_REASONS } from '../../api/moderation.js';

const targetUid = ref('');
const targetName = ref('');
/** 举报原因必须从服务端白名单里选（server/src/services/moderation.js 的 REPORT_REASONS），
 *  自由文本会被 400 E_BAD_REASON 拒绝；想描述情况写进 detail。 */
const reasons = REPORT_REASONS;
const reason = ref(REPORT_REASONS[0]);
const detail = ref('');
const submitting = ref(false);
const msg = ref('');
const ok = ref(false);
const mine = ref([]);

function statusText(s) {
  const map = { pending: '待审核', approved: '已处理', rejected: '未通过', hidden: '已隐藏', banned: '已封禁' };
  return map[s] || s || '待审核';
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function submit() {
  if (!targetUid.value) {
    msg.value = '缺少举报对象：请从转盘/报告结果页进入本页';
    ok.value = false;
    return;
  }
  if (!REPORT_REASONS.includes(reason.value)) {
    msg.value = '请选择举报原因';
    ok.value = false;
    return;
  }
  submitting.value = true;
  msg.value = '';
  try {
    const r = await submitReport({
      targetType: 'user',
      targetId: targetUid.value,
      reason: reason.value,
      detail: detail.value.trim(),
    });
    ok.value = true;
    msg.value = r?.duplicate ? '今天已经举报过这个对象了，我们会继续跟进' : '举报已提交，运营会尽快核实';
    detail.value = '';
    loadMine();
  } catch (e) {
    ok.value = false;
    msg.value = e?.message || '提交失败，请稍后再试';
  } finally {
    submitting.value = false;
  }
}

async function loadMine() {
  try {
    const r = await fetchMyReports(20);
    mine.value = r.items || [];
  } catch {
    mine.value = [];
  }
}

// 从转盘/报告结果页跳进来时带上对象 uid 与昵称。
// onLoad 是小程序与 H5 都可靠的取参方式；getCurrentPages 只作为兜底。
onLoad((q) => {
  const query = q || {};
  targetUid.value = query.uid ? decodeURIComponent(query.uid) : '';
  targetName.value = query.name ? decodeURIComponent(query.name) : '';
});

onMounted(() => {
  if (!targetUid.value) {
    const pages = getCurrentPages();
    const cur = pages[pages.length - 1];
    const query = cur?.options || {};
    if (query.uid) targetUid.value = decodeURIComponent(query.uid);
    if (query.name) targetName.value = decodeURIComponent(query.name);
  }
  loadMine();
});
</script>

<style lang="scss">
.page { padding: 24rpx; background: $color-bg-deep; min-height: 100vh; }
.card { background: $color-bg-sunken; border-radius: 16rpx; padding: 24rpx; margin-bottom: 24rpx; }
.title { font-size: 34rpx; font-weight: 600; color: #fff; display: block; }
.section-title { font-size: 28rpx; color: #fff; display: block; margin-bottom: 12rpx; }
.hint { font-size: 24rpx; color: $color-text-dim; display: block; line-height: 1.7; margin: 10rpx 0 16rpx; }
.target { display: flex; gap: 12rpx; align-items: baseline; margin-bottom: 16rpx; }
.target-label { font-size: 24rpx; color: $color-text-dim; }
.target-name { font-size: 26rpx; color: $color-text-bright; }
.label { font-size: 26rpx; color: $color-text-softer; display: block; margin-bottom: 10rpx; }
.reasons { display: flex; flex-wrap: wrap; margin-bottom: 8rpx; }
.reason-chip { background: $color-bg-deep; border: 1rpx solid rgba(255,255,255,0.12); border-radius: 999rpx; padding: 10rpx 22rpx; margin: 0 12rpx 12rpx 0; font-size: 24rpx; color: $color-text-soft; }
.reason-chip.active { background: rgba(255,107,129,0.18); border-color: $color-pink; color: $color-pink-light; }
.textarea { width: 100%; min-height: 200rpx; background: $color-bg-deep; color: $color-text-bright; border-radius: 12rpx; padding: 18rpx; font-size: 26rpx; box-sizing: border-box; }
.counter { font-size: 22rpx; color: $color-text-dim; display: block; text-align: right; margin-top: 8rpx; }
.btn-primary { background: $color-pink-action; color: #fff; border-radius: 999rpx; margin-top: 16rpx; }
.msg { font-size: 24rpx; display: block; margin-top: 14rpx; line-height: 1.6; }
.msg.ok { color: $color-success-soft; }
.msg.bad { color: $color-danger-soft; }
.mine-item { padding: 16rpx 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
.mine-reason { font-size: 25rpx; color: $color-text-bright; display: block; }
.mine-meta { font-size: 22rpx; color: $color-text-dim; }
</style>
