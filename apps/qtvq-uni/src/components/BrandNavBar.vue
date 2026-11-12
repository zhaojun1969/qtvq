<!--
  三 Tab 顶栏（随页面滚动，不用 fixed，避免挡住点击）
-->
<template>
  <view
    class="brand-nav"
    :style="{ paddingTop: statusBarPx + 'px' }"
  >
    <view class="brand-nav-inner" :style="{ height: navBarPx + 'px' }">
      <image class="brand-logo" src="@/static/logo-108.png" mode="aspectFit" />
      <view v-if="showBrandCenter" class="brand-center">
        <text class="brand-title">Q问</text>
        <!-- 副标题里的官网域名只在微信/H5/App 出现。
             快手《版本信息审核规范》明确禁止"官网、网址、二维码、电话、地址"等引流，
             在别的平台包里顶着一个域名，是最容易被巡检挑出来的那种问题。 -->
        <!-- #ifdef MP-WEIXIN || H5 || APP-PLUS -->
        <text class="brand-sub">我心永恒 · qtvq.cn</text>
        <!-- #endif -->
        <!-- #ifndef MP-WEIXIN || H5 || APP-PLUS -->
        <text class="brand-sub">我心永恒</text>
        <!-- #endif -->
      </view>
      <view v-else-if="centerTitle" class="brand-center">
        <text class="brand-title">{{ centerTitle }}</text>
      </view>
    </view>
  </view>
</template>

<script setup>
defineOptions({
  virtualHost: true,
});

defineProps({
  statusBarPx: { type: Number, required: true },
  navBarPx: { type: Number, required: true },
  navTotalPx: { type: Number, required: true },
  showBrandCenter: { type: Boolean, default: false },
  centerTitle: { type: String, default: '' },
});
</script>

<style lang="scss" scoped>
.brand-nav {
  background: $color-bg;
  border-bottom: 1rpx solid rgba(108, 92, 231, 0.25);
  box-sizing: border-box;
}

.brand-nav-inner {
  position: relative;
  display: flex;
  align-items: center;
  padding: 0 24rpx;
}

.brand-logo {
  width: 56rpx;
  height: 56rpx;
  flex-shrink: 0;
}

.brand-center {
  position: absolute;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.brand-title {
  font-size: 32rpx;
  font-weight: 700;
  color: $color-text;
  line-height: 1.2;
  white-space: nowrap; /* E.80 与主站同规：品牌两行结构各自单行 */
}

.brand-sub {
  font-size: 20rpx;
  color: $color-text-muted;
  line-height: 1.2;
  margin-top: 2rpx;
  white-space: nowrap;
}
</style>
