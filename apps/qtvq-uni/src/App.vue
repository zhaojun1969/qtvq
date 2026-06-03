<script setup>
import { onLaunch } from '@dcloudio/uni-app';
import { getClientId } from './utils/clientId.js';

onLaunch(() => {
  getClientId();
});
</script>

<style lang="scss">
page {
  background-color: #0f0e17;
  color: #f5f5f7;
  font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 28rpx;
}

.btn-primary {
  background: linear-gradient(135deg, #ff6b81 0%, #6c5ce7 100%);
  color: #fff;
  border: none;
  border-radius: 999rpx;
  padding: 20rpx 40rpx;
  font-size: 28rpx;
}

.btn-secondary {
  background: transparent;
  color: #6c5ce7;
  border: 2rpx solid #6c5ce7;
  border-radius: 999rpx;
  padding: 18rpx 36rpx;
  font-size: 26rpx;
}

.card {
  background: #1a1928;
  border-radius: 24rpx;
  border: 1rpx solid rgba(108, 92, 231, 0.3);
  padding: 24rpx;
  margin-bottom: 20rpx;
}
</style>
