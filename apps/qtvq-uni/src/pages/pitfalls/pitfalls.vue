<template>
  <view class="page">
    <view class="head card">
      <text class="title">爱情避坑大全</text>
      <text class="desc">50+ 真实案例 · 直线方案 · 按代价筛选（MVP 展示精选）</text>
    </view>
    <view v-for="item in list" :key="item.id" class="card item" @click="openDetail(item)">
      <view class="row">
        <text class="cat">{{ item.category }}</text>
        <text class="cost">{{ item.cost }}</text>
      </view>
      <text class="item-title">{{ item.title }}</text>
      <text class="meta">已帮 {{ item.helped }} 人避开</text>
    </view>
    <view v-if="detail" class="modal" @click="detail = null">
      <view class="modal-box card" @click.stop>
        <text class="modal-title">{{ detail.title }}</text>
        <text class="modal-body">{{ detailSteps }}</text>
        <button class="btn-primary" @click="askAbout(detail)">用 Q问 咨询此坑</button>
        <button class="btn-secondary modal-close" @click="detail = null">知道了</button>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref } from 'vue';
import sample from '../../data/pitfalls-sample.json';

const list = ref(sample);
const detail = ref(null);
const detailSteps = ref('');

const STEPS = {
  1: '1. 未见面绝不转账\n2. 任何借钱请求直接拒绝\n3. 已转账保留聊天记录',
  2: '1. 设定3个月期限\n2. 到期直接问是否正式在一起\n3. 回避或拖延=离开',
  3: '1. 发底线信息要求沟通期限\n2. 到期无回应则止损\n3. 停止反复道歉',
  4: '1. 大额支出书面约定\n2. 见家长礼物适度\n3. 急催结婚需放慢了解',
  5: '1. 明确边界底线\n2. 原谅需伴随断联行动\n3. 反复越界=重新选择',
};

function openDetail(item) {
  detail.value = item;
  detailSteps.value = STEPS[item.id] || '详见 Web 版避坑大全完整内容。';
}

function askAbout(item) {
  const prompts = {
    1: '网恋没见面就借钱该借吗？',
    2: '暧昧半年不确认关系怎么办？',
    3: '对方冷暴力已读不回怎么办？',
    4: '彩礼大额支付前要注意什么？',
    5: '发现出轨后只有道歉没有行动怎么办？',
  };
  const q = prompts[item.id] || item.title;
  uni.setStorageSync('qtvq_prefill', q);
  uni.switchTab({ url: '/pages/index/index' });
}
</script>

<style lang="scss" scoped>
.page {
  padding: 24rpx;
  padding-bottom: 120rpx;
}

.head {
  margin-bottom: 20rpx;
}

.title {
  display: block;
  font-size: 34rpx;
  font-weight: 700;
  color: #ff8fa3;
}

.desc {
  display: block;
  font-size: 24rpx;
  color: #a0a0b0;
  margin-top: 8rpx;
}

.item-title {
  display: block;
  font-size: 30rpx;
  margin: 12rpx 0;
}

.row {
  display: flex;
  justify-content: space-between;
}

.cat {
  color: #6c5ce7;
  font-size: 24rpx;
}

.cost {
  color: #ff6b81;
  font-size: 22rpx;
}

.meta {
  font-size: 22rpx;
  color: #a0a0b0;
}

.modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40rpx;
  z-index: 99;
}

.modal-box {
  width: 100%;
  max-width: 600rpx;
}

.modal-title {
  display: block;
  font-size: 32rpx;
  font-weight: 600;
  margin-bottom: 20rpx;
  color: #ff8fa3;
}

.modal-body {
  display: block;
  white-space: pre-wrap;
  font-size: 28rpx;
  line-height: 1.6;
  margin-bottom: 24rpx;
  color: #f5f5f7;
}

.modal-close {
  margin-top: 16rpx;
  width: 100%;
}
</style>
