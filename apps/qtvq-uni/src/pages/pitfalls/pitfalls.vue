<template>

  <view class="page">

    <BrandNavBar

      :status-bar-px="statusBarPx"

      :nav-bar-px="navBarPx"

      :nav-total-px="navTotalPx"

      center-title="避坑"

    />

    <view class="page-inner">

      <view class="head card">

        <text class="title">爱情避坑大全</text>

        <text class="desc">50+ 真实案例 · 直线方案 · 本页展示精选 {{ list.length }} 条</text>

      </view>

      <view

        v-for="item in list"

        :key="item.id"

        class="card item"

        hover-class="item-hover"

        @tap="openDetail(item)"

      >

        <view class="row">

          <text class="cat">{{ item.category }}</text>

          <text class="cost">{{ item.cost }}</text>

        </view>

        <text class="item-title">{{ item.title }}</text>

        <text class="meta">已帮 {{ item.helped }} 人避开 · 点击查看直线方案</text>

      </view>

    </view>

    <view v-if="detail" class="modal" @tap="detail = null">

      <view class="modal-box card" @tap.stop>

        <text class="modal-title">{{ detail.title }}</text>

        <text class="modal-body">{{ detailSteps }}</text>

        <button class="btn-primary" @tap="askAbout(detail)">用 Q问 咨询此坑</button>

        <button class="btn-secondary modal-close" @tap="detail = null">知道了</button>

      </view>

    </view>

  </view>

</template>



<script setup>

import { ref } from 'vue';

import { onShow } from '@dcloudio/uni-app';

import sample from '../../data/pitfalls-sample.json';

import BrandNavBar from '../../components/BrandNavBar.vue';

import { useNavBar } from '../../utils/navBar.js';



const { statusBarPx, navBarPx, navTotalPx, initNavBar } = useNavBar();

const list = ref(sample);

const detail = ref(null);

const detailSteps = ref('');



const PROMPTS = {

  1: '网恋没见面就借钱该借吗？',

  2: '暧昧半年不确认关系怎么办？',

  3: '对方冷暴力已读不回怎么办？',

  4: '第一次见家长礼物买太贵了怎么办？',

  5: '彩礼大额支付前要注意什么？',

  6: '发现出轨后只有道歉没有行动怎么办？',

  7: '相亲只谈房车不谈相处怎么办？',

  8: '朋友圈对我单身对别人恋爱中怎么办？',

  9: '网恋照片和真人差距很大怎么办？',

  10: '吵架对方就拉黑消失一周怎么办？',

};



function openDetail(item) {

  detail.value = item;

  detailSteps.value = item.steps || '详见 Web 版避坑大全完整内容。';

}



function askAbout(item) {

  const q = PROMPTS[item.id] || item.title;

  uni.setStorageSync('qtvq_prefill', q);

  uni.switchTab({ url: '/pages/index/index' });

}



onShow(initNavBar);

</script>



<style lang="scss" scoped>

.page {

  background: $color-bg;

  min-height: 100%;

  padding-bottom: calc(48rpx + env(safe-area-inset-bottom));

  box-sizing: border-box;

}



.page-inner {

  padding: 0 24rpx 32rpx;

  box-sizing: border-box;

}



.item-hover {

  opacity: 0.85;

}



.head {

  margin-bottom: 20rpx;

}



.title {

  display: block;

  font-size: 34rpx;

  font-weight: 700;

  color: $color-pink-light;

}



.desc {

  display: block;

  font-size: 24rpx;

  color: $color-text-muted;

  margin-top: 8rpx;

  line-height: 1.5;

}



.item {

  margin-bottom: 16rpx;

}



.row {

  display: flex;

  justify-content: space-between;

  margin-bottom: 8rpx;

}



.cat {

  font-size: 22rpx;

  color: $color-purple;

}



.cost {

  font-size: 22rpx;

  color: $color-pink;

}



.item-title {

  display: block;

  font-size: 28rpx;

  font-weight: 600;

  margin-bottom: 8rpx;

}



.meta {

  font-size: 22rpx;

  color: $color-text-faint;

}



.modal {

  position: fixed;

  inset: 0;

  background: rgba(0, 0, 0, 0.72);

  display: flex;

  align-items: center;

  justify-content: center;

  padding: 32rpx;

  z-index: 200;

}



.modal-box {

  width: 100%;

  max-width: 640rpx;

}



.modal-title {

  display: block;

  font-size: 32rpx;

  font-weight: 700;

  color: $color-pink-light;

  margin-bottom: 16rpx;

}



.modal-body {

  display: block;

  font-size: 26rpx;

  color: $color-text-soft;

  line-height: 1.6;

  white-space: pre-wrap;

  margin-bottom: 24rpx;

}



.modal-close {

  margin-top: 12rpx;

  width: 100%;

}

</style>


