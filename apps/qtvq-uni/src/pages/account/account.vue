<template>
  <view class="page">
    <view v-if="!loggedIn" class="card">
      <view class="tabs">
        <button :class="['tab', mode === 'login' ? 'active' : '']" @click="mode = 'login'">登录</button>
        <button :class="['tab', mode === 'register' ? 'active' : '']" @click="mode = 'register'">注册</button>
        <button :class="['tab', mode === 'forgot' ? 'active' : '']" @click="mode = 'forgot'">忘记密码</button>
      </view>

      <!-- #ifdef MP-WEIXIN -->
      <button class="btn-wechat btn-block" @click="wechatLogin">微信一键登录（推荐）</button>
      <text class="hint wechat-tip">免记密码；若曾用手机号注册，登录后自动绑定微信，便于找回密码。</text>
      <!-- #endif -->

      <template v-if="mode !== 'forgot'">
        <input v-model="phone" class="input" type="number" maxlength="11" placeholder="11 位手机号" />
        <input v-model="password" class="input" password placeholder="密码至少 6 位" />
        <input v-if="mode === 'register'" v-model="password2" class="input" password placeholder="确认密码" />
        <button class="btn-primary btn-block" @click="submit">{{ mode === 'login' ? '手机号登录' : '注册' }}</button>
      </template>

      <template v-else>
        <text class="hint">输入注册手机号与新密码，将用当前微信验证身份（须曾绑定微信）。</text>
        <input v-model="phone" class="input" type="number" maxlength="11" placeholder="注册手机号" />
        <input v-model="password" class="input" password placeholder="新密码至少 6 位" />
        <input v-model="password2" class="input" password placeholder="确认新密码" />
        <button class="btn-primary btn-block" @click="resetPwd">微信验证并重置密码</button>
        <text class="hint">未绑定微信？请联系 qtvq@qtvq.cn 协助重置。</text>
      </template>
    </view>

    <view v-else>
      <view class="card">
        <text class="section-title">账户</text>
        <text class="line">{{ userLabel }}</text>
        <text class="line">设备编号 {{ clientIdShort }}</text>
        <text class="line">{{ quotaText }}</text>
        <button class="btn-primary btn-block" @click="goSubscribe">办理 / 续费会员</button>
        <button class="btn-secondary btn-block" @click="showPwd = !showPwd">修改密码</button>
        <button class="btn-secondary btn-block" @click="logout">退出登录</button>
      </view>

      <view v-if="showPwd" class="card">
        <text class="section-title">修改密码</text>
        <input v-if="user?.hasPassword !== false" v-model="oldPassword" class="input" password placeholder="原密码" />
        <input v-model="newPassword" class="input" password placeholder="新密码" />
        <input v-model="newPassword2" class="input" password placeholder="确认新密码" />
        <button class="btn-primary btn-block" @click="savePwd">保存</button>
      </view>

      <view class="card">
        <text class="section-title">打款与会员状态</text>
        <view v-if="payStatus" :class="['status', payStatus.type]">
          <text>{{ payStatus.title }}</text>
          <text class="detail">{{ payStatus.detail }}</text>
        </view>
        <text v-else class="hint">暂无待核实打款</text>
      </view>

      <view class="card" v-if="history.length">
        <text class="section-title">历史开通</text>
        <text v-for="(h, i) in history" :key="i" class="line">{{ h }}</text>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { getClientId } from '../../utils/clientId.js';
import { isLoggedIn, getAuthUser } from '../../utils/auth.js';
import {
  registerAccount,
  loginAccount,
  loginWechat,
  resetPasswordWechat,
  changePassword,
  fetchAccountMe,
  logoutAccount,
  wechatLoginCode,
} from '../../api/auth.js';
import { formatQuotaText } from '../../utils/user.js';

const mode = ref('login');
const phone = ref('');
const password = ref('');
const password2 = ref('');
const oldPassword = ref('');
const newPassword = ref('');
const newPassword2 = ref('');
const showPwd = ref(false);
const loggedIn = ref(isLoggedIn());
const user = ref(getAuthUser());
const quota = ref(null);
const clientId = ref('');

const clientIdShort = computed(() => {
  const id = clientId.value || '';
  return id.length > 16 ? `${id.slice(0, 16)}…` : id;
});

const userLabel = computed(() => {
  const u = user.value;
  if (!u) return '—';
  if (u.phone) return `手机号 ${u.phone}`;
  if (u.wechatBound) return '微信用户';
  return '已登录';
});

const quotaText = computed(() => (quota.value ? formatQuotaText(quota.value) : '加载中…'));

const payStatus = computed(() => {
  const q = quota.value;
  if (!q) return null;
  if (q.unlimited && q.subscription) {
    const s = q.subscription;
    return {
      type: 'ok',
      title: '✓ 会员已开通',
      detail: `${s.label || s.plan} · 有效期至 ${new Date(s.activeUntil).toLocaleString('zh-CN')}`,
    };
  }
  if (q.paymentPending?.status === 'pending') {
    const p = q.paymentPending;
    return {
      type: 'pending',
      title: '⏳ 打款核实中',
      detail: `${p.planLabel} · ¥${p.amount} · 汇款人 ${p.payerName || '—'}`,
    };
  }
  return null;
});

const history = computed(() =>
  (quota.value?.paymentHistory || []).map(
    (h) => `${h.planLabel || h.plan} · ¥${h.amount} · ${new Date(h.activatedAt || h.submittedAt).toLocaleString('zh-CN')}`,
  ),
);

async function refresh() {
  clientId.value = getClientId();
  if (!isLoggedIn()) {
    loggedIn.value = false;
    return;
  }
  try {
    const data = await fetchAccountMe();
    user.value = data.user;
    quota.value = data.quota;
    loggedIn.value = true;
  } catch {
    loggedIn.value = false;
  }
}

async function wechatLogin() {
  try {
    const code = await wechatLoginCode();
    const data = await loginWechat(code);
    user.value = data.user;
    quota.value = data.quota;
    loggedIn.value = true;
    uni.showToast({ title: '微信登录成功', icon: 'none' });
  } catch (e) {
    uni.showToast({ title: e.message || '微信登录失败', icon: 'none' });
  }
}

async function submit() {
  if (!/^1[3-9]\d{9}$/.test(phone.value)) {
    uni.showToast({ title: '请输入正确手机号', icon: 'none' });
    return;
  }
  if (password.value.length < 6) {
    uni.showToast({ title: '密码至少 6 位', icon: 'none' });
    return;
  }
  if (mode.value === 'register' && password.value !== password2.value) {
    uni.showToast({ title: '两次密码不一致', icon: 'none' });
    return;
  }
  try {
    const fn = mode.value === 'login' ? loginAccount : registerAccount;
    const data = await fn(phone.value, password.value);
    user.value = data.user;
    quota.value = data.quota;
    loggedIn.value = true;
    uni.showToast({ title: mode.value === 'login' ? '登录成功' : '注册成功', icon: 'none' });
  } catch (e) {
    uni.showToast({ title: e.message || '失败', icon: 'none' });
  }
}

async function resetPwd() {
  if (!/^1[3-9]\d{9}$/.test(phone.value)) {
    uni.showToast({ title: '请输入注册手机号', icon: 'none' });
    return;
  }
  if (password.value.length < 6 || password.value !== password2.value) {
    uni.showToast({ title: '请确认新密码', icon: 'none' });
    return;
  }
  try {
    const code = await wechatLoginCode();
    const data = await resetPasswordWechat(phone.value, password.value, code);
    user.value = data.user;
    quota.value = data.quota;
    loggedIn.value = true;
    uni.showToast({ title: '密码已重置', icon: 'none' });
  } catch (e) {
    uni.showToast({ title: e.message || '重置失败', icon: 'none' });
  }
}

async function savePwd() {
  if (newPassword.value.length < 6 || newPassword.value !== newPassword2.value) {
    uni.showToast({ title: '请确认新密码', icon: 'none' });
    return;
  }
  try {
    await changePassword(oldPassword.value, newPassword.value);
    uni.showToast({ title: '密码已更新', icon: 'none' });
    showPwd.value = false;
    oldPassword.value = '';
    newPassword.value = '';
    newPassword2.value = '';
    await refresh();
  } catch (e) {
    uni.showToast({ title: e.message || '修改失败', icon: 'none' });
  }
}

function goSubscribe() {
  uni.navigateTo({ url: '/pages/subscribe/subscribe' });
}

async function logout() {
  await logoutAccount();
  loggedIn.value = false;
  user.value = null;
  quota.value = null;
  uni.showToast({ title: '已退出', icon: 'none' });
}

onMounted(refresh);
</script>

<style lang="scss" scoped>
.page {
  padding: 24rpx;
  padding-bottom: 120rpx;
}

.card {
  background: #1a1928;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 24rpx;
}

.tabs {
  display: flex;
  gap: 12rpx;
  margin-bottom: 24rpx;
}

.tab {
  flex: 1;
  font-size: 24rpx;
  background: #2a2940;
  color: #a0a0b0;
  padding: 0 8rpx;
}

.tab.active {
  background: #6c5ce7;
  color: #fff;
}

.btn-wechat {
  background: #07c160;
  color: #fff;
  font-size: 30rpx;
  margin-bottom: 16rpx;
}

.wechat-tip {
  margin-bottom: 20rpx;
}

.input {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 16rpx;
  padding: 20rpx;
  background: #0f0e17;
  border-radius: 12rpx;
  color: #fff;
  font-size: 28rpx;
}

.btn-block {
  width: 100%;
  margin-top: 12rpx;
}

.hint,
.line,
.detail {
  display: block;
  font-size: 24rpx;
  color: #a0a0b0;
  line-height: 1.6;
  margin-top: 8rpx;
}

.section-title {
  display: block;
  font-size: 28rpx;
  color: #ff8fa3;
  margin-bottom: 12rpx;
}

.status {
  padding: 16rpx;
  border-radius: 12rpx;
  border: 1rpx solid rgba(108, 92, 231, 0.35);
}

.status.ok {
  border-color: rgba(123, 237, 159, 0.5);
}

.status.pending {
  border-color: rgba(245, 158, 11, 0.5);
}
</style>
