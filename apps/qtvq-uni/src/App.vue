<script setup>
import { onLaunch, onHide } from '@dcloudio/uni-app';
import { getClientId } from './utils/clientId.js';
import { initAutoUpdate } from './utils/update.js';
import { captureAttribution, resolveSceneShortCode } from './utils/attribution.js';
import { flush as flushTrack } from './utils/track.js';

onLaunch((options = {}) => {
  getClientId();
  /*
   * 渠道归因（P3-T3.2）：必须在任何上报之前跑，且不能抛错 ——
   * 分享卡/内容矩阵带进来的 scene 是唯一能算出"这条内容带来了谁"的信息，
   * 丢了就永远补不回来；但它出问题也绝不能挡住启动。
   */
  try {
    const att = captureAttribution(options);
    // 小程序码带来的 8 位短码：异步反查成邀请人；失败静默，不阻塞启动、不影响渠道归因
    if (att && att.shortCode) resolveSceneShortCode(att.shortCode);
  } catch {
    /* 归因失败静默 */
  }
  /*
   * 全端自动更新入口（小程序 / App / H5 三种机制在这里分派，见 utils/update.js）。
   *
   * 刻意**不 await**：更新检查会发网络请求，不能挡住首屏。
   * initAutoUpdate 内部对任何异常都做了兜底，更新失败绝不会影响使用。
   */
  initAutoUpdate();
});

/*
 * 切后台时立刻把埋点队列发出去。
 *
 * 小程序的定时器在切后台后会被挂起，只靠 5 秒定时 flush 会把"最后几个事件"
 * 压到下次启动才发（甚至被系统回收后丢失）。而 `landing_view` / `question_asked`
 * 这类事件恰恰经常是用户看完就走 —— 不在这里发，等于漏掉最真实的转化样本。
 */
onHide(() => {
  try {
    flushTrack();
  } catch {
    /* 埋点永不抛 */
  }
});
</script>

<style lang="scss">
/*
 * 全部颜色改由 `src/uni.scss` 的令牌变量提供（由 tools/scripts/gen-tokens.mjs
 * 从 packages/tokens 生成，uni-app 自动注入每个 SFC）。
 *
 * 2026-10-25 之前这里是硬编码：$color-bg / $color-text / $color-pink / $color-purple / $color-bg-card ——
 * 这些值恰好与官网 CSS 变量同值，但两端各写一份，无法机械保证一致。
 */
page {
  background-color: $color-bg;
  color: $color-text;
  font-family: $font-stack;
  font-size: 28rpx;
}

.btn-primary {
  background: $gradient-brand;
  color: #fff;
  border: none;
  border-radius: 999rpx;
  padding: 20rpx 40rpx;
  font-size: 28rpx;
  line-height: 1.4;
}

.btn-primary::after,
.btn-secondary::after {
  border: none;
}

.btn-secondary {
  background: transparent;
  color: $color-purple;
  border: 2rpx solid $color-purple;
  border-radius: 999rpx;
  padding: 18rpx 36rpx;
  font-size: 26rpx;
  line-height: 1.4;
}

button {
  margin: 0;
  box-sizing: border-box;
}

button.btn-block {
  display: block;
  width: 100%;
}

.card {
  background: $color-bg-card;
  border-radius: $radius-md;
  border: 1rpx solid rgba(108, 92, 231, 0.3);
  padding: $space-lg;
  margin-bottom: 20rpx;
}
</style>
