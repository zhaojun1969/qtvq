<!--
  18+ 年龄门弹层（2026-10-28 · 计划书 E.40）

  为什么是一个组件而不是一个页面：年龄门必须**挡在付费动作前面**，
  做成页面就要处理"返回时原页面还在不在""用户点返回算不算同意"这些额外状态。
  组件挂在页面里，`ensure()` 返回 Promise<boolean>，调用方拿到 false 就中止 —— 没有第三种状态。

  用法：
    <AdultGate ref="adultGate" />
    const ok = await ensureAdult(adultGate, '生成配对报告');
    if (!ok) return;
-->
<template>
  <view v-if="visible" class="ag-mask">
    <view class="ag-panel">
      <text class="ag-title">{{ title }}</text>
      <text class="ag-desc">
        本产品面向 <text class="ag-strong">18–30 岁成年人</text>，提供情感避坑与配对报告服务。
        为遵守相关法规，需要先确认你的出生年份。
      </text>

      <picker mode="selector" :range="yearLabels" :value="yearIndex" @change="onPick">
        <view :class="['ag-field', yearIndex < 0 ? 'ag-field-ph' : '']">
          {{ yearIndex >= 0 ? yearLabels[yearIndex] : '请选择出生年份' }}
        </view>
      </picker>

      <view class="ag-agree" @tap="agreed = !agreed">
        <view :class="['ag-box', agreed ? 'ag-box-on' : '']">
          <text v-if="agreed" class="ag-tick">✓</text>
        </view>
        <text class="ag-agree-text">
          我已阅读并同意《成年用户承诺》：我确认已年满 18 周岁，且理解本产品不构成心理或法律建议。
        </text>
      </view>

      <text v-if="error" class="ag-error">{{ error }}</text>

      <view class="ag-actions">
        <button class="ag-btn ag-ghost" @tap="settle(false)">暂不</button>
        <button class="ag-btn ag-primary" :disabled="submitting" @tap="confirm">
          {{ submitting ? '提交中…' : '确认' }}
        </button>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { submitAdult } from '../utils/adult.js';

const visible = ref(false);
const submitting = ref(false);
const agreed = ref(false);
const error = ref('');
const action = ref('继续');
const yearIndex = ref(-1);

let resolver = null;

const thisYear = new Date().getFullYear();
// 与官网一致：从今年往前 60 年（覆盖 18–30 岁人群，也允许更大年龄自我声明）
const years = [];
for (let y = thisYear; y >= thisYear - 60; y -= 1) years.push(y);
const yearLabels = years.map((y) => `${y} 年（${thisYear - y} 岁）`);

const title = computed(() => `成年用户确认（${action.value}前）`);

function onPick(e) {
  const idx = Number(e?.detail?.value);
  if (Number.isInteger(idx) && idx >= 0) {
    yearIndex.value = idx;
    error.value = '';
  }
}

function settle(result) {
  visible.value = false;
  submitting.value = false;
  const r = resolver;
  resolver = null;
  if (r) r(Boolean(result));
}

async function confirm() {
  if (yearIndex.value < 0) {
    error.value = '请选择出生年份';
    return;
  }
  if (!agreed.value) {
    error.value = '请先勾选《成年用户承诺》';
    return;
  }
  submitting.value = true;
  error.value = '';
  try {
    await submitAdult(years[yearIndex.value]);
    settle(true);
  } catch (e) {
    // 未满 18 的文案来自服务端（E_UNDERAGE），不在客户端另写一套
    error.value = e?.message || '提交失败，请重试';
  } finally {
    submitting.value = false;
  }
}

/** 打开弹层；resolve(true) 表示已通过，resolve(false) 表示用户放弃 */
function ensure(actionText = '继续') {
  action.value = actionText;
  agreed.value = false;
  error.value = '';
  yearIndex.value = -1;
  visible.value = true;
  return new Promise((resolve) => {
    resolver = resolve;
  });
}

defineExpose({ ensure });
</script>

<style lang="scss" scoped>
.ag-mask {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: flex-end;
  z-index: 999;
}
.ag-panel {
  width: 100%;
  background: $color-bg-card;
  border-top-left-radius: $radius-lg;
  border-top-right-radius: $radius-lg;
  padding: $space-lg;
  padding-bottom: calc(#{$space-lg} + env(safe-area-inset-bottom));
}
.ag-title {
  display: block;
  font-size: 32rpx;
  font-weight: 600;
  color: $color-text;
  margin-bottom: 16rpx;
}
.ag-desc {
  display: block;
  font-size: 25rpx;
  line-height: 1.7;
  color: $color-text-dim;
  margin-bottom: 24rpx;
}
.ag-strong {
  color: $color-text;
  font-weight: 600;
}
.ag-field {
  background: $color-bg-deep;
  color: $color-text;
  border-radius: $radius-sm;
  padding: 20rpx 24rpx;
  font-size: 27rpx;
}
.ag-field-ph {
  color: $color-text-dim;
}
.ag-agree {
  display: flex;
  align-items: flex-start;
  margin-top: 24rpx;
}
.ag-box {
  width: 32rpx;
  height: 32rpx;
  border: 2rpx solid $color-text-dim;
  border-radius: 8rpx;
  margin-right: 14rpx;
  margin-top: 4rpx;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ag-box-on {
  background: $color-pink;
  border-color: $color-pink;
}
.ag-tick {
  font-size: 22rpx;
  color: #fff;
  line-height: 1;
}
.ag-agree-text {
  flex: 1;
  font-size: 24rpx;
  line-height: 1.6;
  color: $color-text-softer;
}
.ag-error {
  display: block;
  font-size: 24rpx;
  color: $color-danger-soft;
  margin-top: 16rpx;
}
.ag-actions {
  display: flex;
  gap: 20rpx;
  margin-top: 28rpx;
}
.ag-btn {
  flex: 1;
  border-radius: 999rpx;
  font-size: 28rpx;
  line-height: 1.4;
  padding: 20rpx 0;
}
.ag-ghost {
  background: transparent;
  color: $color-text-softer;
  border: 2rpx solid rgba(255, 255, 255, 0.16);
}
.ag-primary {
  background: $gradient-brand;
  color: #fff;
}
.ag-btn::after {
  border: none;
}
</style>
