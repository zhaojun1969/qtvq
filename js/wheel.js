/**
 * 转盘页逻辑 + Canvas 转盘
 *
 * 核心约束：**抽签结果必须由服务端决定**。
 * 所以顺序永远是「先调 `/v1/wheel/spin` 拿到 `targetIndex` → 再把动画停到那个扇区」，
 * 前端**不含**任何 `Math.random()` 决定落点的代码。
 * 计划书原来的写法是先在前端随机 targetIndex、再回传 target_uid，那样任何人都能
 * 直接构造请求指定想配对的人，也能重放刷次数。
 *
 * 另一处刻意偏离计划书：计划书让「中心圆点」当指针、绕圈旋转。
 * 指针与转盘同时转会让人无法判断"到底指向谁"，这里改成
 * **转盘转、顶部指针固定**（老虎机形态）——落点唯一、可核对、可复现。
 */
import { showToast } from './app.js';
import { isLoggedIn } from './auth.js';
import * as api from './report-api.js';

const $ = (id) => document.getElementById(id);

const COLORS = {
  sectorA: '#1a1928',
  sectorB: '#242338',
  line: '#0f3460',
  pink: '#ff6b7f',
  highlight: 'rgba(255, 107, 129, 0.30)',
  text: '#f5f5f7',
};

const state = {
  sectors: [],
  current: null,
  spinning: false,
  loggedIn: false,
  needsProfile: false,
  price: 1,
  tier: 'deep',
  pendingKey: null,
};

let canvas;
let ctx;
let size = 340;
let rotation = -Math.PI / 2;
const imgCache = new Map();

// ---------------------------------------------------------------- 工具

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pct(v) {
  return `${Math.round((Number(v) || 0) * 100)}%`;
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

/**
 * 幂等键生命周期（与 report.js 同一规则）：
 * 只有「没拿到服务端响应」（超时/断网）才保留键重试；服务端已答复就换新键。
 */
async function withKey(fn) {
  if (!state.pendingKey) state.pendingKey = api.newIdempotencyKey();
  try {
    const r = await fn(state.pendingKey);
    state.pendingKey = null;
    return r;
  } catch (err) {
    if (err instanceof api.ReportApiError && err.status > 0) state.pendingKey = null;
    throw err;
  }
}

// ---------------------------------------------------------------- 绘制

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const maxW = Math.min(340, window.innerWidth - 72);
  size = Math.max(240, Math.floor(maxW));
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function draw(rot = rotation, highlight = -1) {
  const R = size / 2;
  ctx.clearRect(0, 0, size, size);

  const n = state.sectors.length || 8;
  const ap = (Math.PI * 2) / n;

  // 头像圆心所在半径与可用弧长（扇区越多，头像越小，避免互相压叠）
  const ringR = R - 58;
  const slotW = (2 * Math.PI * ringR) / n;
  const avR = Math.max(9, Math.min(26, slotW * 0.34));

  for (let i = 0; i < n; i++) {
    const start = rot + i * ap;
    const end = start + ap;

    ctx.beginPath();
    ctx.moveTo(R, R);
    ctx.arc(R, R, R - 6, start, end);
    ctx.closePath();
    ctx.fillStyle = i === highlight ? COLORS.highlight : i % 2 === 0 ? COLORS.sectorA : COLORS.sectorB;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.line;
    ctx.stroke();

    const mid = start + ap / 2;
    const ax = R + Math.cos(mid) * ringR;
    const ay = R + Math.sin(mid) * ringR;
    drawAvatar(ax, ay, i === highlight ? avR * 1.2 : avR, state.sectors[i], i === highlight);
  }

  // 外圈
  ctx.beginPath();
  ctx.arc(R, R, R - 3, 0, Math.PI * 2);
  ctx.lineWidth = 6;
  ctx.strokeStyle = COLORS.line;
  ctx.stroke();
}

/** 性别 -> 剪影配色（男/女区分；未填资料用中性色） */
function genderPalette(gender) {
  const g = String(gender || '').toLowerCase();
  if (g === 'male') return { c1: '#3b7dd8', c2: '#173a66' };
  if (g === 'female') return { c1: '#e2708f', c2: '#6f3560' };
  return { c1: '#8b90a8', c2: '#3a3f55' };
}

/**
 * 画「模拟人像」剪影（**刻意不是真人照片**）。
 *
 * 为什么用剪影而不是合成人脸：扇区里的候选人是**真实注册账号**，只是没上传头像。
 * 拿一张照片级的合成人脸当他的头像，会让人误以为那是本人的照片 —— 那是误导
 * （见 docs/计划书对齐与整改实施方案.md §3 意见 4：虚拟头像池是欺诈红线）。
 * 剪影一眼可辨为插画，男女靠配色与长发区分，既解决了「?」难看的问题，也不涉及假冒。
 */
function paintSimAvatar(x, y, r, gender) {
  const { c1, c2 } = genderPalette(gender);
  const grad = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
  grad.addColorStop(0, c1);
  grad.addColorStop(1, c2);
  ctx.fillStyle = grad;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);

  const g = String(gender || '').toLowerCase();
  const headR = r * 0.30;
  const headY = y - r * 0.16;

  // 肩（上半椭圆）
  ctx.fillStyle = 'rgba(255,255,255,0.90)';
  ctx.beginPath();
  ctx.ellipse(x, y + r * 0.56, r * 0.42, r * 0.34, 0, Math.PI, Math.PI * 2);
  ctx.fill();

  // 女性加两侧长发，便于一眼区分（先画发、再画脸盖上去）
  if (g === 'female') {
    ctx.fillStyle = 'rgba(255,255,255,0.48)';
    ctx.beginPath();
    ctx.ellipse(x, headY + headR * 0.45, headR * 1.30, headR * 1.55, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // 头
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.beginPath();
  ctx.arc(x, headY, headR, 0, Math.PI * 2);
  ctx.fill();
}

function drawAvatar(x, y, r, item, highlight) {
  const uid = item?.uid || '';
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  const img = imgCache.get(uid);
  if (img && img.complete && img.naturalWidth) {
    ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
  } else {
    paintSimAvatar(x, y, r, item?.gender);
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.lineWidth = highlight ? 3 : 2;
  ctx.strokeStyle = highlight ? COLORS.pink : 'rgba(255,107,129,0.55)';
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

/** 预加载扇区头像；失败就保留首字兜底，不影响转动 */
function preloadAvatars() {
  for (const item of state.sectors) {
    if (!item?.avatar || imgCache.has(item.uid)) continue;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => draw();
    img.onerror = () => {
      /* 保留首字兜底 */
    };
    img.src = item.avatar;
    imgCache.set(item.uid, img);
  }
}

/**
 * 动画：把转盘从当前角度转到「指针（顶部 -90°）落在 targetIndex 扇区中心」。
 * 用 easeOutQuart，至少转 6 圈，落点精确可复现。
 */
function animateTo(targetIndex) {
  const n = state.sectors.length;
  const ap = (Math.PI * 2) / n;

  // 指针在 -π/2；要让 targetIndex 扇区中心正对指针
  const desired = -Math.PI / 2 - (targetIndex * ap + ap / 2);
  let final = desired;
  const turns = 6;
  while (final < rotation + turns * Math.PI * 2) final += Math.PI * 2;

  const start = rotation;
  const total = final - start;
  const duration = 4200;
  const t0 = performance.now();

  return new Promise((resolve) => {
    function step(now) {
      const t = Math.min((now - t0) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 4);
      rotation = start + total * ease;
      draw(rotation);
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        rotation = final;
        draw(rotation, targetIndex);
        resolve();
      }
    }
    requestAnimationFrame(step);
  });
}

// ---------------------------------------------------------------- 结果卡片

// 结果卡片里的头像：有真实头像就显示；没有就显示**性别区分的模拟人像剪影**（不是真人照片）
function cardAvatarHtml(t) {
  if (t.avatar) return `<div class="avatar"><img src="${escapeHtml(t.avatar)}" alt=""></div>`;
  const g = String(t.gender || '').toLowerCase();
  const cls = g === 'male' ? 'male' : g === 'female' ? 'female' : 'na';
  const hair = g === 'female'
    ? '<ellipse cx="32" cy="27" rx="15.5" ry="18" fill="rgba(255,255,255,0.48)"/>'
    : '';
  return `<div class="avatar sim-${cls}">
      <svg class="avatar-sim" viewBox="0 0 64 64" role="img" aria-label="模拟形象（该用户未上传头像）">
        ${hair}
        <ellipse cx="32" cy="57" rx="18" ry="15" fill="rgba(255,255,255,0.90)"/>
        <circle cx="32" cy="24" r="10.5" fill="rgba(255,255,255,0.94)"/>
      </svg>
    </div>`;
}

function renderCard(res) {
  const t = res.target || {};
  const b = res.billing || {};
  const tags = Array.isArray(t.tags) ? t.tags : [];

  $('result-card').innerHTML = `
    ${cardAvatarHtml(t)}
    <h3>${escapeHtml(t.nickname || 'TA')}</h3>
    <div class="meta">${escapeHtml([t.age ? `${t.age} 岁` : null, t.city].filter(Boolean).join(' · ') || '资料未填全')}</div>
    <div class="score">初步契合度 <b>${pct(res.score)}</b></div>
    ${tags.length ? `<div class="tags">${tags.map((x) => `<span>${escapeHtml(x)}</span>`).join('')}</div>` : ''}
    ${t.intro ? `<p class="intro">${escapeHtml(t.intro)}</p>` : ''}
    <p class="wheel-hint">
      ${b.replayed ? '这次是重复提交，已为你打开上一次的结果（未重复扣费）' : b.charged > 0 ? `本次扣除 ¥${b.charged}${typeof b.balance === 'number' ? `，余额 ¥${b.balance.toFixed(2)}` : ''}` : escapeHtml(b.label || '本次免费')}
    </p>
    <div class="tier-pick" id="tier-pick">
      ${api.TIERS.map((x) => `<button type="button" data-tier="${x.key}" class="${x.key === state.tier ? 'active' : ''}">${escapeHtml(x.zh)}<small>¥${x.price}</small></button>`).join('')}
    </div>
    <div class="result-actions">
      <button type="button" class="btn btn-primary" id="btn-make-report">生成配对报告</button>
      <button type="button" class="btn btn-secondary" id="btn-more">再转一次</button>
      <button type="button" class="btn btn-secondary" id="btn-complain">举报这个资料</button>
    </div>
    <p class="wheel-hint">报告按所选档位另计费（与转盘费互相独立，不会重复收费）。</p>
  `;
  $('result-card').classList.remove('hidden');

  $('tier-pick').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tier]');
    if (!btn) return;
    state.tier = btn.dataset.tier;
    $('tier-pick').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  });
  $('btn-make-report').addEventListener('click', onMakeReport);
  $('btn-more').addEventListener('click', () => {
    $('result-card').classList.add('hidden');
    onSpin();
  });
  $('btn-complain').addEventListener('click', onComplain);
}

async function onMakeReport() {
  const btn = $('btn-make-report');
  const target = state.current?.target;
  if (!target) return;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>生成中…';
  try {
    const res = await withKey((key) => api.generateReport({ targetUid: target.uid, tier: state.tier, idempotencyKey: key }));
    location.href = `report.html?id=${encodeURIComponent(res.reportId)}`;
  } catch (err) {
    if (err?.needFunds) {
      notice(`<strong>${escapeHtml(err.message)}</strong><br>可以去 <a href="account.html">我的账户</a> 充值后回来生成。`, 'warn');
    } else if (err?.blocked) {
      notice('报告生成被内容安全策略拦下，请检查你的资料表述。', 'warn');
    } else {
      showToast(err?.message || '生成失败');
    }
    btn.disabled = false;
    btn.textContent = '生成配对报告';
  }
}

async function onComplain() {
  const target = state.current?.target;
  if (!target) return;
  const reason = prompt(`举报 ${target.nickname || 'TA'} 的原因，请输入：涉黄 / 广告 / 诈骗 / 辱骂 / 头像违规 / 虚假资料 / 其他`);
  if (!reason) return;
  try {
    const r = await api.submitReport({ targetType: 'user', targetId: target.uid, reason: reason.trim() });
    showToast(r?.duplicate ? '今天已经举报过这个对象了' : '举报已提交，运营会尽快核实');
  } catch (err) {
    showToast(err?.message || '举报失败');
  }
}

// ---------------------------------------------------------------- 数据

async function loadWallet() {
  try {
    const data = await api.fetchWallet();
    $('wheel-wallet').classList.remove('hidden');
    $('wallet-balance').textContent = `¥${Number(data.wallet.balance).toFixed(2)}`;
    const m = data.membership?.active;
    $('wallet-note').textContent = m ? '会员生效中（每日有免费转动）' : '未开通会员（会员每日可免转数次）';
  } catch {
    /* 钱包读不到不影响转盘，按钮上的价格另有兜底 */
  }
}

async function loadQuoteAndCandidates() {
  try {
    const q = await api.fetchWheelQuote();
    state.price = Number(q.price) || 0;
    $('btn-spin').textContent = state.price > 0 ? `转一圈 ¥${state.price}` : '转一圈（免费）';
    $('spin-hint').innerHTML =
      q.amount === 0
        ? escapeHtml(q.label || '本次免费')
        : `每次 ¥${q.price} · 从余额扣除 · 余额不足不会扣款`;
  } catch (err) {
    if (err?.needLogin) return;
    $('spin-hint').textContent = '';
  }

  try {
    const data = await api.fetchWheelCandidates();
    state.needsProfile = !!data.needsProfile;
    state.sectors = data.items || [];
    if (state.needsProfile) {
      notice('转盘需要先知道你的性别才能只出异性。请先到 <a href="report.html">配对报告</a> 页面填写资料（昵称 + 性别即可）。', 'warn');
      $('btn-spin').disabled = true;
    } else if (data.empty) {
      notice(
        `${escapeHtml(data.hint || '还没有可配对的用户')}<br>可以到 <a href="report.html">配对报告</a> 生成邀请链接发给朋友。`,
        'warn',
      );
      $('btn-spin').disabled = true;
    }
    resizeCanvas();
    preloadAvatars();
  } catch (err) {
    if (!err?.needLogin) notice(`读取候选失败：${escapeHtml(err.message)}`, 'warn');
    $('btn-spin').disabled = true;
  }
}

async function loadHistory() {
  if (!state.loggedIn) {
    $('history-list').innerHTML = '<div class="wheel-hint">登录后可以查看自己的转动记录。</div>';
    return;
  }
  try {
    const data = await api.fetchSpinHistory(10);
    const items = data.items || [];
    if (!items.length) {
      $('history-list').innerHTML = '<div class="wheel-hint">还没有转动记录。</div>';
      return;
    }
    $('history-list').innerHTML = items
      .map(
        (x) => `
      <div class="history-item">
        <div>
          <div>契合度 ${pct(x.matchedScore)}</div>
          <div class="hi-meta">${escapeHtml(new Date(x.createdAt).toLocaleString('zh-CN'))}</div>
        </div>
        <div class="hi-amount">${x.amount > 0 ? `-¥${x.amount}` : '免费'}</div>
      </div>`,
      )
      .join('');
  } catch (err) {
    $('history-list').innerHTML = `<div class="wheel-hint">读取失败：${escapeHtml(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------- 转动

async function onSpin() {
  if (state.spinning) return;
  if (!state.loggedIn) {
    location.href = 'account.html';
    return;
  }
  if (state.needsProfile) {
    location.href = 'report.html';
    return;
  }
  state.spinning = true;
  const btn = $('btn-spin');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>转动中…';
  clearNotices();

  try {
    // 先拿服务端的抽签结果，再动动画 —— 顺序不能反
    const res = await withKey((key) => api.spinWheel({ idempotencyKey: key }));

    if (res.empty) {
      notice(`${escapeHtml(res.hint || '暂时没有可配对的用户')}`, 'warn');
      return;
    }

    state.current = res;
    state.sectors = res.sectors || [];
    resizeCanvas();
    preloadAvatars();
    $('result-card').classList.add('hidden');

    await animateTo(res.targetIndex);
    renderCard(res);
    loadWallet();
    loadHistory();
  } catch (err) {
    if (err?.needLogin) {
      location.href = 'account.html';
      return;
    }
    if (err?.needFunds) {
      notice(`<strong>${escapeHtml(err.message)}</strong><br>可以去 <a href="account.html">我的账户</a> 充值或办理会员后再转。`, 'warn');
    } else if (err?.code === 'E_DUPLICATE_IN_FLIGHT') {
      showToast('上一次转动还在处理中，请稍等一下');
    } else {
      notice(`转动失败：${escapeHtml(err?.message || '未知错误')}`, 'warn');
    }
  } finally {
    state.spinning = false;
    btn.disabled = state.needsProfile;
    btn.textContent = state.price > 0 ? `转一圈 ¥${state.price}` : '转一圈';
  }
}

// ---------------------------------------------------------------- 初始化

function init() {
  canvas = $('wheel-canvas');
  ctx = canvas.getContext('2d');
  state.loggedIn = isLoggedIn();

  if (!state.loggedIn) {
    notice('转盘需要登录，这样报告和余额才能跟着账号走。<a href="account.html">去登录 / 注册 →</a>', 'warn');
  }

  $('btn-spin').addEventListener('click', onSpin);
  window.addEventListener('resize', () => resizeCanvas());

  resizeCanvas();
  loadWallet();
  loadQuoteAndCandidates();
  loadHistory();

  // 未登录时也画一个占位转盘，避免页面空白
  if (!state.sectors.length) draw();
}

init();
