<template>
  <view class="page">
    <view class="card">
      <text class="title">{{ t('contact.title') }}</text>
      <text class="hint">{{ t('contact.hint') }}</text>
    </view>
    <view class="card">
      <textarea
        v-model="message"
        class="input"
        :placeholder="t('contact.placeholderMessage')"
        maxlength="5000"
      />
      <input v-model="replyEmail" class="field" :placeholder="t('contact.placeholderEmail')" />
      <button class="btn-primary btn-block" :disabled="submitting" @click="submit">{{ t('contact.submit') }}</button>
    </view>
  </view>
</template>

<script setup>
import { ref } from 'vue';
import { submitContact } from '../../api/contact.js';
import { getClientId } from '../../utils/clientId.js';
import { t } from '@qtvq/i18n';

const message = ref('');
const replyEmail = ref('');
const submitting = ref(false);

async function submit() {
  const text = message.value.trim();
  if (!text) {
    uni.showToast({ title: t('contact.toastEmpty'), icon: 'none' });
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
      title: t('contact.modalTitle'),
      content: t('contact.modalContent'),
      showCancel: false,
      success: () => uni.navigateBack(),
    });
  } catch (e) {
    uni.showToast({ title: e.message || t('contact.toastFailed'), icon: 'none' });
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
  color: $color-pink-light;
}

.hint {
  display: block;
  font-size: 24rpx;
  color: $color-text-muted;
  margin-top: 12rpx;
  line-height: 1.5;
}

.input {
  width: 100%;
  min-height: 240rpx;
  background: $color-bg;
  border: 1rpx solid rgba(108, 92, 231, 0.4);
  border-radius: 12rpx;
  padding: 16rpx;
  color: $color-text;
  font-size: 28rpx;
  box-sizing: border-box;
  margin-bottom: 16rpx;
}

.field {
  width: 100%;
  background: $color-bg;
  border: 1rpx solid rgba(108, 92, 231, 0.4);
  border-radius: 12rpx;
  padding: 20rpx;
  color: $color-text;
  font-size: 28rpx;
  margin-bottom: 16rpx;
  box-sizing: border-box;
}

.btn-block {
  width: 100%;
}
</style>
