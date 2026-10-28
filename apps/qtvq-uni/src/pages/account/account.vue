<template>
  <view class="page">
    <view v-if="!loggedIn" class="card">
      <view class="tabs">
        <button :class="['tab', mode === 'login' ? 'active' : '']" @click="mode = 'login'">登录</button>
        <button :class="['tab', mode === 'register' ? 'active' : '']" @click="mode = 'register'">注册</button>
        <!-- 短信找回不需要微信，H5 / App 端同样保留这个入口 -->
        <button :class="['tab', mode === 'forgot' ? 'active' : '']" @click="mode = 'forgot'">忘记密码</button>
      </view>

      <!-- #ifdef MP-WEIXIN -->
      <button class="btn-wechat btn-block" @click="wechatLogin">微信一键登录（推荐）</button>
      <text class="hint wechat-tip">不用记密码；若曾用手机号注册，登录后自动绑定微信，忘记密码时可微信验证找回。</text>
      <!-- #endif -->
      <!-- #ifndef MP-WEIXIN -->
      <text class="hint wechat-tip">请使用手机号注册 / 登录。</text>
      <!-- #endif -->

      <template v-if="mode !== 'forgot'">
        <input v-model="phone" class="input" type="number" maxlength="11" placeholder="11 位手机号" />
        <input v-model="password" class="input" password placeholder="密码至少 6 位" />
        <input v-if="mode === 'register'" v-model="password2" class="input" password placeholder="确认密码" />
        <button class="btn-primary btn-block" @click="submit">{{ mode === 'login' ? '手机号登录' : '注册' }}</button>
      </template>

      <template v-else>
        <text class="hint">① 短信验证码找回（推荐，不需要额外授权）：填手机号 → 获取验证码 → 填新密码。</text>
        <input v-model="phone" class="input" type="number" maxlength="11" placeholder="注册手机号" />
        <view class="code-row">
          <input v-model="smsCode" class="input code-input" type="number" maxlength="6" placeholder="6 位验证码" />
          <button class="btn-secondary code-btn" :disabled="smsCooldown > 0 || smsSending" @click="sendCode">
            {{ smsSending ? '发送中…' : smsCooldown > 0 ? smsCooldown + 's 后可重发' : '获取验证码' }}
          </button>
        </view>
        <input v-model="password" class="input" password placeholder="新密码至少 6 位" />
        <input v-model="password2" class="input" password placeholder="确认新密码" />
        <button class="btn-primary btn-block" @click="resetBySms">短信验证并重置密码</button>
        <text v-if="smsMsg" class="hint">{{ smsMsg }}</text>

        <!-- #ifdef MP-WEIXIN -->
        <text class="hint">② 或：用微信验证身份重置（须曾绑定微信）。</text>
        <button class="btn-secondary btn-block" @click="resetPwd">微信验证并重置密码</button>
        <!-- #endif -->
        <text class="hint">两者都不行？回到「我的」→「联系客服」提交，我们会协助重置。</text>
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
        <text v-if="user?.hasPassword === false" class="hint">
          你这个账号还没有密码（之前用第三方账号登录）。直接填新密码保存即可，之后就能用手机号+密码登录。
        </text>
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

      <!-- 注销账号：破坏性操作，放最后并写清后果 -->
      <view class="card danger">
        <text class="section-title">注销账号</text>
        <text class="hint">
          注销后<text class="strong">个人资料、登录凭证、提问记录、第三方账号绑定立即删除且不可恢复</text>；
          订单以脱敏方式保留（金额/时间保留，身份信息隐去）用于财务留痕。
          会员未到期或有待核实付款时不允许自助注销，请先联系客服协商。
        </text>
        <!-- 确认方式可切换：有密码的账号验密码，纯微信账号要打「注销账号」四个字。
             做成可切换是为了不留死胡同 —— 万一 hasPassword 没取到（缓存旧数据/接口失败），
             用户还有另一条路可走，而不是卡在一个填不对的输入框前。 -->
        <input
          v-if="deleteMode === 'password'"
          v-model="deletePassword"
          class="input"
          password
          placeholder="输入登录密码以确认"
        />
        <input
          v-else
          v-model="deleteConfirm"
          class="input"
          placeholder="请输入四个字：注销账号"
        />
        <text class="hint link" @tap="toggleDeleteMode">
          {{ deleteMode === 'password' ? '没有设置密码？改用输入「注销账号」确认' : '有密码？改回用密码确认' }}
        </text>
        <button class="btn-danger btn-block" :disabled="deleting" @click="doDelete">
          {{ deleting ? '处理中…' : '确认注销我的账号' }}
        </button>
        <text v-if="deleteMsg" class="hint">{{ deleteMsg }}</text>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { getClientId } from '../../utils/clientId.js';
import { isLoggedIn, getAuthUser, clearAuthSession } from '../../utils/auth.js';
import {
  registerAccount,
  loginAccount,
  loginWechat,
  resetPasswordWechat,
  resetPasswordBySms,
  sendSmsCode,
  changePassword,
  fetchAccountMe,
  logoutAccount,
  deleteAccount,
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

// —— 忘记密码 / 短信重置
const smsCode = ref('');
const smsCooldown = ref(0);
const smsSending = ref(false);
const smsMsg = ref('');
let smsTimer = null;

// —— 注销账号
const deletePassword = ref('');
const deleteConfirm = ref('');
const deleting = ref(false);
const deleteMsg = ref('');
/** 'password' = 验登录密码；'text' = 打「注销账号」四个字（纯微信账号走这条） */
const deleteMode = ref('password');

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
    // 有密码就默认走密码确认；纯微信账号（hasPassword=false）自动切到口令确认，
    // 用户仍可手动切换（见 toggleDeleteMode）
    if (data.user?.hasPassword === false) deleteMode.value = 'text';
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

// 发送短信验证码：服务端有 60 秒 / 每日 10 条 / 每 IP 每小时 20 条三重限流，
// 这里的倒计时只是本地体验优化，被服务端拒绝时以服务端返回的原因为准。
async function sendCode() {
  if (smsCooldown.value > 0 || smsSending.value) return;
  if (!/^1[3-9]\d{9}$/.test(phone.value)) {
    uni.showToast({ title: '请先填写 11 位手机号', icon: 'none' });
    return;
  }
  smsSending.value = true;
  smsMsg.value = '';
  try {
    const r = await sendSmsCode(phone.value);
    smsMsg.value = r?.message || '验证码已发送，5 分钟内有效。';
    uni.showToast({ title: '验证码已发送', icon: 'none' });
    smsCooldown.value = 60;
    if (smsTimer) clearInterval(smsTimer);
    smsTimer = setInterval(() => {
      smsCooldown.value -= 1;
      if (smsCooldown.value <= 0) {
        clearInterval(smsTimer);
        smsTimer = null;
      }
    }, 1000);
  } catch (e) {
    smsMsg.value = e.message || '验证码发送失败';
    uni.showToast({ title: smsMsg.value, icon: 'none' });
  } finally {
    smsSending.value = false;
  }
}

async function resetBySms() {
  if (!/^1[3-9]\d{9}$/.test(phone.value)) {
    uni.showToast({ title: '请输入注册手机号', icon: 'none' });
    return;
  }
  if (!/^\d{6}$/.test(smsCode.value)) {
    uni.showToast({ title: '请输入 6 位验证码', icon: 'none' });
    return;
  }
  if (password.value.length < 6 || password.value !== password2.value) {
    uni.showToast({ title: '请确认新密码（至少 6 位）', icon: 'none' });
    return;
  }
  try {
    const data = await resetPasswordBySms(phone.value, smsCode.value, password.value);
    // 该接口只返回结果、不发放登录态（服务端刻意如此），所以重置后回到登录页让用户用新密码登录
    mode.value = 'login';
    smsCode.value = '';
    password2.value = '';
    smsMsg.value = data?.message || '密码已重置，请用新密码登录';
    uni.showToast({ title: '密码已重置，请登录', icon: 'none' });
  } catch (e) {
    smsMsg.value = e.message || '重置失败';
    uni.showToast({ title: smsMsg.value, icon: 'none' });
  }
}

function toggleDeleteMode() {
  deleteMode.value = deleteMode.value === 'password' ? 'text' : 'password';
  deleteMsg.value = '';
}

async function doDelete() {
  if (deleting.value) return;
  const usePassword = deleteMode.value === 'password';
  if (usePassword && !deletePassword.value) {
    uni.showToast({ title: '请输入登录密码', icon: 'none' });
    return;
  }
  if (!usePassword && deleteConfirm.value.trim() !== '注销账号') {
    uni.showToast({ title: '请输入「注销账号」四个字', icon: 'none' });
    return;
  }
  // 二次确认：破坏性操作必须显式点过
  const ok = await new Promise((resolve) => {
    uni.showModal({
      title: '确认注销账号',
      content: '资料与记录将立即删除且不可恢复，订单脱敏保留。确定继续？',
      confirmText: '确定注销',
      // script 里拿不到 SCSS 变量，这里是 packages/tokens 的 dangerSoft 字面量
      confirmColor: '#ff8a8a',
      success: (res) => resolve(!!res.confirm),
      fail: () => resolve(false),
    });
  });
  if (!ok) return;

  deleting.value = true;
  deleteMsg.value = '';
  try {
    const r = await deleteAccount(
      hasPwd
        ? { password: deletePassword.value }
        : { confirmText: deleteConfirm.value.trim() },
    );
    deleteMsg.value = r?.message || '账号已注销。';
    clearAuthSession();
    loggedIn.value = false;
    user.value = null;
    quota.value = null;
    deletePassword.value = '';
    deleteConfirm.value = '';
    uni.showToast({ title: '账号已注销', icon: 'none' });
  } catch (e) {
    deleteMsg.value = e.message || '注销失败，请通过「联系客服」提交，我们会协助处理';
    uni.showToast({ title: deleteMsg.value, icon: 'none' });
  } finally {
    deleting.value = false;
  }
}

async function logout() {
  await logoutAccount();
  loggedIn.value = false;
  user.value = null;
  quota.value = null;
  uni.showToast({ title: '已退出', icon: 'none' });
}

onMounted(refresh);
onUnmounted(() => {
  if (smsTimer) {
    clearInterval(smsTimer);
    smsTimer = null;
  }
});
</script>

<style lang="scss" scoped>
.page {
  padding: 24rpx;
  padding-bottom: 120rpx;
}

.card {
  background: $color-bg-card;
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
  background: $color-bg-raised;
  color: $color-text-muted;
  padding: 0 8rpx;
}

.tab.active {
  background: $color-purple;
  color: #fff;
}

.btn-wechat {
  background: $color-brand-wechat;
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
  height: 88rpx;
  line-height: 88rpx;
  box-sizing: border-box;
  margin-bottom: 16rpx;
  padding: 0 24rpx;
  background: $color-bg;
  border: 1rpx solid rgba(108, 92, 231, 0.4);
  border-radius: 12rpx;
  color: $color-text;
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
  color: $color-text-muted;
  line-height: 1.6;
  margin-top: 8rpx;
}

.section-title {
  display: block;
  font-size: 28rpx;
  color: $color-pink-light;
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

/* —— 验证码行：输入框占满剩余宽度，按钮固定宽度并换行显示倒计时 —— */
.code-row {
  display: flex;
  align-items: center;
  gap: 12rpx;
}

.code-input {
  flex: 1;
  min-width: 0;
  margin-bottom: 16rpx;
}

.code-btn {
  width: 240rpx;
  flex: none;
  font-size: 24rpx;
  margin-bottom: 16rpx;
  padding: 0 8rpx;
  white-space: nowrap;
}

/* —— 注销账号：危险区域用红色边框和红色标题，避免误触 ——
 *
 * 2026-10-28 配色对齐主站（原先是小程序自己发明的一套红：rgba(231,76,60) / #ff7675 / #c0392b）。
 * 官网"注销账号"区域用的是 rgba(255,92,92,α) + var(--danger-text)，这里逐字对齐；
 * 主色不变、只是把三档各不相同的红收敛成同一档，跨端看起来才是同一个产品。 */
.card.danger {
  border: 1rpx solid rgba(255, 92, 92, 0.45);
  background: rgba(255, 92, 92, 0.06);
}

.card.danger .section-title {
  color: $color-danger-text;
}

.strong {
  color: $color-pink-light;
  font-weight: 600;
}

/* 可点击的次要说明（如"改用输入注销账号确认"） */
.hint.link {
  color: $color-purple-light;
  text-decoration: underline;
}

/* 主站 .btn.btn-danger 是"描边 + 红字"而不是实心深红；
   实心 #c0392b 在深底上显得脏，且与主站按钮体系不一致。 */
.btn-danger {
  background: rgba(255, 92, 92, 0.12);
  color: $color-danger-text;
  border: 1rpx solid rgba(255, 92, 92, 0.6);
  font-size: 28rpx;
}

.btn-danger[disabled] {
  opacity: 0.6;
}
</style>
