<template>
  <web-view v-if="url" :src="url" />
</template>

<script setup>
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

const url = ref('');

onLoad((opts) => {
  if (opts?.url) {
    url.value = decodeURIComponent(opts.url);
  }
  if (opts?.title) {
    uni.setNavigationBarTitle({ title: decodeURIComponent(opts.title) });
  }
});
</script>

<style scoped>
web-view {
  width: 100%;
  height: 100vh;
}
</style>
