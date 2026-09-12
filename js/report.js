/**
 * 配对报告页逻辑
 *
 * 页面职责收敛为一件事：把「资料 → 配对 → 报告」这条链路在浏览器侧跑通。
 * 所有判定（档位、权限、脱敏）都在服务端，这里只做展示与交互，不复制业务规则。
 */
import { showToast } from './app.js';
import { isLoggedIn } from './auth.js';
import * as api from './report-api.js';
import { downloadReportCard } from './report-share.js';

const $ = (id) => document.getElementById(id);

const state = {
  profile: null,
  tier: 'deep',
  report: null,
  shareToken: null, // 来自 URL 或分享接口
  inviteToken: null,
  backendReady: false,
  loggedIn: false,
};

let gender = null;

// ---------------------------------------------------------------- 工具

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pct(v) {
  return `${Math.round((Number(v) || 0) * 100)}%`;
}

function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function notice(html, kind = '') {
  const el = document.createElement('div');
  el.className = `notice${kind ? ` notice-${kind}` : ''}`;
  el.innerHTML = html;
  $('notice-slot').appendChild(el);
  return el;
}

function clearNotices() {
  $('notice-slot').innerHTML = '';
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 回退到 execCommand */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function avatarHtml(person, cls = '') {
  const name = escapeHtml((person?.nickname || '?').slice(0, 1));
  if (person?.avatar) {
    return `<div class="avatar ${cls}"><img src="${escapeHtml(person.avatar)}" alt="${escapeHtml(person.nickname || '')}"></div>`;
  }
  return `<div class="avatar ${cls}">${name}</div>`;
}

function metaLine(p) {
  const bits = [];
  if (p?.age) bits.push(`${p.age} 岁`);
  if (p?.city) bits.push(p.city);
  return bits.join(' · ');
}

// ---------------------------------------------------------------- 提示与门禁

function renderBackendDown(detail) {
  notice(
    `配对报告服务暂时不可用${detail ? `（${escapeHtml(detail)}）` : ''}。<br>
     本页依赖新的报告服务（Node + MongoDB）。部署完成后，在 <code>qtvq.cn</code> 的 Nginx 上把
     <code>/v1/</code> 反代到 <code>127.0.0.1:3000</code> 即可，详见 <code>server/README.md</code>。`,
    'warn',
  );
}

function renderNeedLogin(action = '生成配对报告') {
  const el = notice(
    `要${escapeHtml(action)}，请先 <a href="account.html">登录 / 注册</a>。
     报告需要绑定账号，这样换设备也能看到自己生成过的报告。`,
    'warn',
  );
  return el;
}

function requireLogin() {
  if (!state.loggedIn) {
    renderNeedLogin();
    return false;
  }
  return true;
}

/** 资料是否足以生成报告（与服务端 completeness 判定保持同一门槛：允许缺 1 项） */
function profileReady(profile) {
  if (!profile) return false;
  const c = profile.completeness;
  if (!c) return true;
  return !c.missing?.length || c.missing.length <= 1;
}

// ---------------------------------------------------------------- 资料

function fillProfileForm(p) {
  $('pf-nickname').value = p?.nickname || '';
  $('pf-age').value = p?.age || '';
  $('pf-city').value = p?.city || '';
  $('pf-job').value = p?.job || '';
  $('pf-height').value = p?.height || '';
  $('pf-tags').value = Array.isArray(p?.tags) ? p.tags.join(', ') : '';
  $('pf-intro').value = p?.intro || '';
  gender = p?.gender || null;
  renderGender();
}

function renderGender() {
  document.querySelectorAll('#pf-gender button').forEach((b) => {
    b.classList.toggle('active', b.dataset.gender === gender);
  });
}

const MISSING_LABEL = { nickname: '昵称', gender: '性别', age: '年龄', city: '城市', tags: '兴趣标签', intro: '自我介绍' };

function renderCompleteness(p) {
  const el = $('profile-completeness');
  if (!p?.completeness) {
    el.textContent = '';
    return;
  }
  const { score, missing } = p.completeness;
  if (!missing?.length) {
    el.innerHTML = `资料完整度 <b>${Math.round(score * 100)}%</b> · 可以生成报告了`;
    return;
  }
  const names = missing.map((m) => MISSING_LABEL[m] || m).join('、');
  el.innerHTML = `资料完整度 <b>${Math.round(score * 100)}%</b> · 还缺 <span class="miss">${escapeHtml(names)}</span>`;
}

async function loadProfile() {
  try {
    const data = await api.fetchMyProfile();
    state.profile = data?.user || null;
    fillProfileForm(state.profile);
    renderCompleteness(state.profile);
  } catch (err) {
    if (err.needLogin) {
      state.loggedIn = false;
      return;
    }
    showToast(err.message);
  }
}

async function saveProfile(e) {
  e.preventDefault();
  if (!requireLogin()) return;

  const tagsRaw = $('pf-tags').value;
  const tags = tagsRaw
    .split(/[,，、\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10);

  const patch = {
    nickname: $('pf-nickname').value.trim(),
    gender,
    age: Number($('pf-age').value) || undefined,
    city: $('pf-city').value.trim(),
    job: $('pf-job').value.trim(),
    height: Number($('pf-height').value) || undefined,
    tags,
    intro: $('pf-intro').value.trim(),
  };
  // 去掉空值，避免把选填项写成空串
  for (const k of Object.keys(patch)) {
    if (patch[k] === undefined || patch[k] === '' || (Array.isArray(patch[k]) && !patch[k].length)) delete patch[k];
  }
  if (!patch.gender) {
    showToast('请选择性别');
    return;
  }
  if (!patch.nickname) {
    showToast('请填写昵称');
    return;
  }

  const btn = $('btn-save-profile');
  const original = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>保存中…';
  try {
    const data = await api.saveMyProfile(patch);
    state.profile = data?.user || null;
    renderCompleteness(state.profile);
    showToast(data?.vectorUpdated ? '已保存，资料向量已更新' : '已保存');
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ---------------------------------------------------------------- 档位

function renderTierGrid() {
  const grid = $('tier-grid');
  grid.innerHTML = api.TIERS.map(
    (t) => `
    <button type="button" class="tier-card${t.key === state.tier ? ' active' : ''}" data-tier="${t.key}">
      <div class="tier-name">${escapeHtml(t.zh)}</div>
      <div class="tier-price">¥${t.price}</div>
      <div class="tier-desc">${escapeHtml(t.desc)}</div>
      <span class="tier-free">当前阶段不扣费</span>
    </button>`,
  ).join('');

  grid.querySelectorAll('.tier-card').forEach((card) => {
    card.addEventListener('click', () => {
      state.tier = card.dataset.tier;
      grid.querySelectorAll('.tier-card').forEach((c) => c.classList.toggle('active', c === card));
    });
  });
}

// ---------------------------------------------------------------- 报告渲染

function renderReport(report, { isOwner = true } = {}) {
  state.report = report;
  const me = report.me || {};
  const target = report.target || {};
  const dims = Object.keys(report.scores || {});
  const labels = report.labels || {};

  const dimHtml = dims
    .map((k) => {
      const v = Math.max(0, Math.min(1, Number(report.scores[k]) || 0));
      return `
      <div class="dim-row">
        <div class="dim-top"><span>${escapeHtml(labels[k] || k)}</span><span class="dim-val">${pct(v)}</span></div>
        <div class="bar"><div style="width:${Math.round(v * 100)}%"></div></div>
        ${report.basis?.[k] ? `<div class="dim-basis">依据：${escapeHtml(report.basis[k])}</div>` : ''}
      </div>`;
    })
    .join('');

  const pitfallHtml = (report.pitfalls || []).length
    ? `<div class="report-tags">${report.pitfalls
        .map((p) => `<span>${escapeHtml(p.title || '')}${p.category ? ` · ${escapeHtml(p.category)}` : ''}</span>`)
        .join('')}</div>`
    : '';

  const shareHtml = state.shareToken
    ? `<p class="panel-hint" style="margin:0 0 14px">你是通过分享链接查看的这份报告，可以生成分享长图。</p>`
    : '';

  $('report-body').innerHTML = `
    ${report.fallback ? '<div class="notice notice-warn">本次未调用到语言模型，正文为基于算法分数与平台案例库生成的确定性报告。</div>' : ''}
    ${shareHtml}
    <div class="report-head">
      <div class="person">
        ${avatarHtml(me)}
        <div class="name">${escapeHtml((me.nickname || '我').slice(0, 12))}</div>
        <div class="meta">${escapeHtml(metaLine(me))}</div>
      </div>
      <div class="score-block">
        <div class="score">${pct(report.overall)}</div>
        <div class="score-label">综合契合度</div>
        <span class="tier-badge">${escapeHtml(report.tierZh || '')} · ¥${report.price ?? ''}</span>
      </div>
      <div class="person">
        ${avatarHtml(target)}
        <div class="name">${escapeHtml((target.nickname || 'TA').slice(0, 12))}</div>
        <div class="meta">${escapeHtml(metaLine(target))}</div>
      </div>
    </div>

    <div class="dim-list">${dimHtml}</div>

    <div class="report-content">${escapeHtml(report.content || '')}</div>
    ${pitfallHtml}

    <div class="report-actions">
      <button type="button" class="btn btn-primary" id="btn-share-report">
        ${state.shareToken ? '复制分享链接' : '生成分享链接'}
      </button>
      <button type="button" class="btn btn-secondary" id="btn-share-image">下载分享长图</button>
      <button type="button" class="btn btn-secondary" id="btn-back-list">返回报告列表</button>
    </div>
    <p class="panel-hint" style="margin:16px 0 0">
      ${isOwner ? '这份报告归你所有，' : '这份报告由他人分享，'}
      分享链接 ${state.shareToken ? '30 天内有效' : '生成后 30 天内有效'}；
      报告内容仅供沟通参考。
    </p>
  `;

  $('panel-report').classList.remove('hidden');
  $('btn-share-report').addEventListener('click', onShareReport);
  $('btn-share-image').addEventListener('click', onShareImage);
  $('btn-back-list').addEventListener('click', () => {
    $('panel-report').classList.add('hidden');
    $('panel-list').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('panel-report').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function onShareReport() {
  if (state.shareToken) {
    const url = api.absoluteUrl(`/report.html?id=${state.report.reportId}&share=${state.shareToken}`);
    (await copyText(url)) ? showToast('分享链接已复制') : showToast(url);
    return;
  }
  if (!requireLogin()) return;
  try {
    const data = await api.shareReport(state.report.reportId);
    state.shareToken = data.shareToken;
    const url = api.absoluteUrl(data.path);
    // 回填 state，便于后续「下载分享长图」把二维码指向分享地址
    renderReport(state.report, { isOwner: true });
    (await copyText(url)) ? showToast('分享链接已复制') : showToast(url);
  } catch (err) {
    showToast(err.message);
  }
}

async function onShareImage() {
  const btn = $('btn-share-image');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>出图中…';
  const shareUrl = state.shareToken
    ? api.absoluteUrl(`/report.html?id=${state.report.reportId}&share=${state.shareToken}`)
    : api.absoluteUrl('/report.html');
  const res = await downloadReportCard(state.report, { shareUrl });
  btn.disabled = false;
  btn.textContent = '下载分享长图';
  showToast(res.ok ? '分享长图已开始下载' : res.error);
}

// ---------------------------------------------------------------- 列表

function renderReportList(items) {
  const box = $('report-list-body');
  if (!items?.length) {
    box.innerHTML = '<div class="empty-state">还没有报告。<br>先完善资料，然后生成一个邀请链接发给 TA。</div>';
    return;
  }
  box.innerHTML = `<div class="report-list">${items
    .map(
      (r) => `
      <div class="report-item" data-id="${escapeHtml(r.id)}">
        <div class="ri-main">
          <div class="ri-title">与 ${escapeHtml(r.targetSnapshot?.nickname || 'TA')} 的配对报告</div>
          <div class="ri-meta">${escapeHtml(r.tierZh || '')} · ${escapeHtml(fmtDate(r.createdAt))}${r.fallback ? ' · 兜底生成' : ''}</div>
        </div>
        <div class="ri-score">${pct(r.overall)}</div>
      </div>`,
    )
    .join('')}</div>`;

  box.querySelectorAll('.report-item').forEach((el) => {
    el.addEventListener('click', async () => {
      try {
        const report = await api.fetchReport(el.dataset.id);
        state.shareToken = null;
        renderReport(report, { isOwner: true });
      } catch (err) {
        showToast(err.message);
      }
    });
  });
}

async function loadReportList() {
  if (!state.loggedIn) {
    $('report-list-body').innerHTML =
      '<div class="empty-state">登录后可以查看自己生成过的报告。<br><a href="account.html">去登录 / 注册 →</a></div>';
    return;
  }
  try {
    const data = await api.listMyReports();
    renderReportList(data?.items || []);
  } catch (err) {
    $('report-list-body').innerHTML = `<div class="empty-state">读取失败：${escapeHtml(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------- 邀请

async function onCreateInvite() {
  if (!requireLogin()) return;
  if (!profileReady(state.profile)) {
    showToast('请先完善资料，至少填完昵称、性别、年龄、城市、标签、简介中的 5 项');
    return;
  }
  const btn = $('btn-create-invite');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>生成中…';
  try {
    const data = await api.createInvite({ note: '' });
    const url = api.absoluteUrl(data.path);
    $('invite-link').value = url;
    $('btn-copy-invite').disabled = false;
    const copied = await copyText(url);
    showToast(copied ? '邀请链接已复制，发给 TA 即可' : '邀请链接已生成');
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '生成邀请链接';
  }
}

async function loadInviteLanding(token) {
  state.inviteToken = token;
  const box = $('invite-landing');
  box.classList.remove('hidden');
  try {
    const data = await api.fetchInvite(token);
    const from = data.from || {};
    $('invite-from-hint').innerHTML = `${escapeHtml(from.nickname || '一位用户')} 邀请你做一次配对。
      接受后会生成你们两人的契合度报告，双方看的是同一份。`;
    $('invite-from-card').innerHTML = `
      <div class="report-head">
        <div class="person">
          ${avatarHtml(from)}
          <div class="name">${escapeHtml((from.nickname || 'TA').slice(0, 12))}</div>
          <div class="meta">${escapeHtml(metaLine(from))}</div>
        </div>
      </div>
      ${Array.isArray(from.tags) && from.tags.length ? `<div class="report-tags">${from.tags.map((t) => `<span>${escapeHtml(t)}</span>`).join('')}</div>` : ''}`;

    $('btn-accept-invite').disabled = !state.loggedIn;
    if (!state.loggedIn) {
      $('btn-accept-invite').textContent = '登录后接受邀请';
    }
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    $('invite-from-hint').textContent = err.message;
    $('invite-from-card').innerHTML = '';
    $('btn-accept-invite').disabled = true;
  }
}

async function onAcceptInvite() {
  if (!state.loggedIn) {
    location.href = 'account.html';
    return;
  }
  if (!profileReady(state.profile)) {
    showToast('请先完善自己的资料，对方才能得到有意义的报告');
    $('panel-profile').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const btn = $('btn-accept-invite');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>正在生成报告…';
  try {
    const report = await api.acceptInvite(state.inviteToken, { tier: state.tier });
    state.shareToken = report.shareToken || null;
    $('invite-landing').classList.add('hidden');
    renderReport(report, { isOwner: false });
    showToast('报告已生成');
    loadReportList();
  } catch (err) {
    showToast(err.message);
    btn.disabled = false;
    btn.textContent = '接受并生成配对报告';
  }
}

// ---------------------------------------------------------------- 生成（按 uid，内测用）

async function onGenerateByUid() {
  if (!requireLogin()) return;
  const targetUid = $('target-uid').value.trim();
  if (!targetUid) {
    showToast('请填写对方账号 ID');
    return;
  }
  if (!profileReady(state.profile)) {
    showToast('请先完善自己的资料（至少 5 项）');
    return;
  }
  const btn = $('btn-generate-by-uid');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>生成中…';
  try {
    const report = await api.generateReport({ targetUid, tier: state.tier });
    state.shareToken = null;
    renderReport(report, { isOwner: true });
    showToast('报告已生成');
    loadReportList();
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '生成配对报告';
  }
}

// ---------------------------------------------------------------- 初始化

async function init() {
  renderTierGrid();

  const url = new URL(location.href);
  const reportId = url.searchParams.get('id');
  const shareToken = url.searchParams.get('share');
  const inviteToken = url.searchParams.get('invite');

  // 1) 后端可用性
  try {
    await api.fetchReportHealth();
    state.backendReady = true;
  } catch (err) {
    state.backendReady = false;
    renderBackendDown(err.message);
  }

  // 2) 登录态
  state.loggedIn = isLoggedIn();
  if (!state.loggedIn) {
    renderNeedLogin(inviteToken ? '接受邀请' : '生成配对报告');
  }

  // 3) 直接查看某份报告（分享链接优先，不需要登录）
  if (reportId) {
    try {
      const report = await api.fetchReport(reportId, { shareToken });
      state.shareToken = shareToken || null;
      renderReport(report, { isOwner: !shareToken });
    } catch (err) {
      notice(`无法打开这份报告：${escapeHtml(err.message)}`, 'warn');
    }
  }

  // 4) 邀请落地
  if (inviteToken) await loadInviteLanding(inviteToken);

  // 5) 登录后加载资料与列表
  if (state.loggedIn && state.backendReady) {
    await loadProfile();
    await loadReportList();
  } else if (state.loggedIn && !state.backendReady) {
    $('report-list-body').innerHTML = '<div class="empty-state">报告服务不可用。</div>';
  } else {
    await loadReportList();
  }

  // 6) 事件绑定
  $('pf-gender').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-gender]');
    if (!btn) return;
    gender = btn.dataset.gender;
    renderGender();
  });
  $('profile-form').addEventListener('submit', saveProfile);
  $('btn-create-invite').addEventListener('click', onCreateInvite);
  $('btn-copy-invite').addEventListener('click', async () => {
    const v = $('invite-link').value;
    if (!v) return;
    showToast((await copyText(v)) ? '已复制' : v);
  });
  $('btn-toggle-advanced').addEventListener('click', () => {
    const box = $('advanced-generate');
    box.classList.toggle('hidden');
  });
  $('btn-generate-by-uid').addEventListener('click', onGenerateByUid);
  $('btn-accept-invite').addEventListener('click', onAcceptInvite);
  $('btn-refresh-list')?.addEventListener('click', loadReportList);
}

init();
