<template>
  <view class="page">
    <view class="card">
      <text class="title">联系客服</text>
      <text class="hint">留言将发送至 qtvq@qtvq.cn，请勿填写银行卡密码等敏感信息。</text>
    </view>
    <view class="card">
      <textarea
        v-model="message"
        class="input"
        placeholder="描述您的问题或建议…"
        maxlength="5000"
      />
      <input v-model="replyEmail" class="field" placeholder="方便回复的邮箱（选填）" />
      <button class="btn-primary btn-block" :disabled="submitting" @click="submit">提交留言</button>
    </view>
  </view>
</template>

<script setup>
import { ref } from 'vue';
import { submitContact } from '../../api/contact.js';
import { getClientId } from '../../utils/clientId.js';

const message = ref('');
const replyEmail = ref('');
const submitting = ref(false);

async function submit() {
  const text = message.value.trim();
  if (!text) {
    uni.showToast({ title: '请填写留言', icon: 'none' });
    return;
  }
  submitting.value = true;
  try {
    await submitContact({
      message: text,
      replyEmail: replyEmail.value.trim(),
      clientId: getClientId(),
    });
    uni.showModal({
      title: '已提交',
      content: '客服将尽快回复，感谢反馈。',
      showCancel: false,
      success: () => uni.navigateBack(),
    });
  } catch (e) {
    uni.showToast({ title: e.message || '提交失败', icon: 'none' });
  } finally {
    submitting.value = false;
  }
}
</script>

<style lang="scss" scoped>
.page {
  padding: 24rpx;
}

.title {
  display: block;
  font-size: 32rpx;
  font-weight: 700;
  color: #ff8fa3;
}

.hint {
  display: block;
  font-size: 24rpx;
  color: #a0a0b0;
  margin-top: 12rpx;
  line-height: 1.5;
}

.input {
  width: 100%;
  min-height: 240rpx;
  background: #0f0e17;
  border: 1rpx solid rgba(108, 92, 231, 0.4);
  border-radius: 12rpx;
  padding: 16rpx;
  color: #f5f5f7;
  font-size: 28rpx;
  box-sizing: border-box;
  margin-bottom: 16rpx;
}

.field {
  width: 100%;
  background: #0f0e17;
  border: 1rpx solid rgba(108, 92, 231, 0.4);
  border-radius: 12rpx;
  padding: 20rpx;
  color: #f5f5f7;
  font-size: 28rpx;
  margin-bottom: 16rpx;
  box-sizing: border-box;
}

.btn-block {
  width: 100%;
}
</style>
