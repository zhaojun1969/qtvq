/**
 * 避坑诊断 / 关系复盘页逻辑（实施书 P2-T2.1 / T2.2 / T2.4 的前端侧）
 *
 * 页面职责与 report.js 一致：只负责「输入 → 下单 → 轮询 → 展示 → 分享」，
 * 所有判定（价格、额度、年龄、内容安全、脱敏）都在服务端，这里不复制业务规则。
 *
 * 与配对报告页的差别：
 *   · 不需要填资料、不需要对方账号（diagnose/retro 都是"只关于我自己"的报告）；
 *   · 分享链接走短链 `/r/<token>`，二维码指向它，落地页用公开摘要接口渲染；
 *   · 分享卡用 canvas 在本机出图（服务器没有中文字体，服务端渲染会出方框）。
 */
import { showToast } from './app.js';
import { isLoggedIn } from './auth.js';
import * as api from './report-api.js';
import { ensureAdult } from './adult-gate.js';
import { track } from './track.js';
import { downloadAdviceCard } from './report-share.js';

const $ = (id) => document.getElementById(id);

const state = {
  loggedIn: false,
  skus: {},
  scenes: {},
  sku: null,
  pickedScenes: new Set(),
  report: null,
  shareToken: null,
  busy: false,
  billingOn: null,
  credits: null,
};

const KIND_TITLE = { diagnose: '避坑诊断', retro: '关系复盘' };

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function notice(html, kind = '') {
  $('notice-slot').innerHTML = `<div class="notice ${kind ? `notice-${kind}` : ''}">${html}</div>`;
}

function clearNotices() {
  $('notice-slot').innerHTML = '';
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 非 https / 无权限时回退 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 商品选择

function moneyOf(fen) {
  return `¥${(Number(fen || 0) / 100).toFixed(2)}`;
}

function renderSkuGrid() {
  const grid = $('sku-grid');
  const keys = ['diagnose', 'retro'];
  grid.innerHTML = keys
    .map((key) => {
      const s = state.skus[key];
      if (!s) return '';
      const intro = s.introFen && s.yourPriceFen === s.introFen ? `<span class="tier-free">首单 ${moneyOf(s.introFen)}</span>` : '';
      const price = s.yourPriceFen != null ? moneyOf(s.yourPriceFen) : moneyOf(s.priceFen);
      return `
      <button type="button" class="tier-card${key === state.sku ? ' active' : ''}" data-sku="${escapeHtml(key)}">
        <div class="tier-name">${escapeHtml(s.zh || KIND_TITLE[key])}</div>
        <div class="tier-price">${price}</div>
        <div class="tier-desc">${escapeHtml(s.desc || '')}</div>
        ${intro}
      </button>`;
    })
    .join('');

  grid.querySelectorAll('.tier-card').forEach((card) => {
    card.addEventListener('click', () => chooseSku(card.dataset.sku));
  });

  const c = state.credits;
  $('billing-hint').innerHTML = state.billingOn === false
    ? '计费当前未开启（服务端 <code>ENFORCE_REPORT_BILLING=0</code>）：会正常生成并记录流水，但不扣余额。'
    : `${c && c.total > 0 ? `会员本期报告额度剩余 <strong>${c.remaining}/${c.total}</strong>；` : ''}生成前会校验余额，<strong>余额不足不会扣款</strong>；同一请求重复提交只扣一次。`;
}

function chooseSku(key) {
  state.sku = key;
  state.pickedScenes.clear();
  document.querySelectorAll('#sku-grid .tier-card').forEach((c) => c.classList.toggle('active', c.dataset.sku === key));
  $('panel-input').classList.remove('hidden');
  $('input-title').textContent = `2 · ${KIND_TITLE[key] || '诊断'}：说说你的情况`;
  $('btn-generate').textContent = key === 'diagnose' ? '生成避坑诊断' : '生成关系复盘';
  renderForm(key);
  try {
    track('report_pay_intent', { sku: key, stage: 'choose' });
  } catch {
    /* 埋点永不打断主流程 */
  }
  $('panel-input').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderForm(key) {
  const slot = $('advice-form-slot');
  if (key === 'diagnose') {
    const sceneChips = Object.entries(state.scenes)
      .map(([k, label]) => `<button type="button" class="advice-scene" data-scene="${escapeHtml(k)}">${escapeHtml(label)}</button>`)
      .join('');
    slot.innerHTML = `
      <div class="advice-field">
        <label class="field-label" for="ad-description">你现在的处境（越具体越准，至少 10 个字）</label>
        <textarea id="ad-description" rows="6" maxlength="1200"
          placeholder="例如：我们认识三个月，他只在周末找我，平时消息经常隔天才回。我提过两次要不要确定关系，他都说再处处看。">${escapeHtml(state.lastInput?.description || '')}</textarea>
        <p class="field-hint">别写姓名、手机号、微信号；只描述行为和时间线就够。</p>
      </div>
      <div class="advice-field">
        <span class="field-label">场景标签（可多选，最多 4 个）</span>
        <div class="advice-scenes" id="ad-scenes">${sceneChips}</div>
      </div>
      <div class="advice-field">
        <label class="field-label" for="ad-question">你最想问的一句话（选填）</label>
        <input id="ad-question" type="text" maxlength="80" placeholder="例如：我该不该主动问清楚？">
      </div>`;
    slot.querySelectorAll('[data-scene]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const k = chip.dataset.scene;
        if (state.pickedScenes.has(k)) state.pickedScenes.delete(k);
        else if (state.pickedScenes.size < 4) state.pickedScenes.add(k);
        else showToast('最多选 4 个标签');
        chip.classList.toggle('active', state.pickedScenes.has(k));
      });
    });
    return;
  }

  slot.innerHTML = `
    <div class="advice-two-col">
      <div class="advice-field">
        <label class="field-label" for="ad-self">你的视角（发生了什么、你怎么感受的）</label>
        <textarea id="ad-self" rows="6" maxlength="1200" placeholder="例如：我每天下班回家做饭、洗碗，他下班就躺着刷手机……"></textarea>
      </div>
      <div class="advice-field">
        <label class="field-label" for="ad-partner">对方视角（选填；填了复盘会更准）</label>
        <textarea id="ad-partner" rows="6" maxlength="1200" placeholder="例如：他说我总在挑毛病，他觉得家务是我自己要求做的……"></textarea>
      </div>
    </div>
    <div class="advice-field">
      <label class="field-label" for="ad-history">关键经过（按时间顺序，越具体越好）</label>
      <textarea id="ad-history" rows="5" maxlength="1200" placeholder="例如：同居两年，前一年他还会帮忙，第二年开始基本不做。最近一次争吵我摔了碗，他三天没跟我说话。"></textarea>
    </div>
    <div class="advice-field">
      <label class="field-label" for="ad-question">你最想弄清楚的一句话（选填）</label>
      <input id="ad-question" type="text" maxlength="80" placeholder="例如：还有没有必要继续？">
    </div>`;
}

// ---------------------------------------------------------------- 生成

function readInput(key) {
  const question = ($('ad-question')?.value || '').trim();
  if (key === 'diagnose') {
    const description = ($('ad-description')?.value || '').trim();
    if (description.length < 10) return { error: '请把处境写清楚一些（至少 10 个字）' };
    return { payload: { description, scenes: [...state.pickedScenes], question } };
  }
  const selfView = ($('ad-self')?.value || '').trim();
  if (selfView.length < 10) return { error: '请先把你的视角写清楚（至少 10 个字）' };
  return {
    payload: {
      selfView,
      partnerView: ($('ad-partner')?.value || '').trim(),
      history: ($('ad-history')?.value || '').trim(),
      question,
    },
  };
}

function handleError(err) {
  if (err?.needLogin) {
    notice('请先 <a href="account.html">登录</a> 后再生成。', 'warn');
    return;
  }
  if (err?.needFunds) {
    notice(`<strong>${escapeHtml(err.message)}</strong><br>可以在 <a href="account.html">我的账户</a> 充值后再来。`, 'warn');
    showToast('余额不足');
    return;
  }
  if (err?.code === 'E_NEED_PAY') {
    const info = err?.data || {};
    const yuan = info.price != null ? Number(info.price).toFixed(2) : null;
    const creditsLine = info?.credits?.total > 0
      ? `会员本期额度已用完（${info.credits.used}/${info.credits.total} 份），下期自动恢复。`
      : '可以直接单份购买，或办理会员每月领额度。';
    notice(
      `<strong>这是一份付费报告</strong>${yuan ? `（¥${escapeHtml(yuan)}）` : ''}<br>${creditsLine}` +
        '<br>当前支付通道未开通，可先在 <a href="account.html">我的账户</a> 用对公汇款充值，到账后再来生成。',
      'warn',
    );
    showToast('需要先完成支付');
    return;
  }
  if (err?.code === 'E_NEED_BIRTHYEAR' || err?.code === 'E_UNDERAGE') {
    notice(`<strong>${escapeHtml(err.message)}</strong><br>本页报告仅面向 18 岁以上用户。`, 'warn');
    return;
  }
  if (err?.blocked) {
    const cats = err.safety?.categories?.join('、') || '违规内容';
    notice(`内容未通过安全检查（${escapeHtml(cats)}），请换一种说法。`, 'warn');
    return;
  }
  notice(`<strong>${escapeHtml(err?.message || '生成失败')}</strong>`, 'warn');
  showToast(err?.message || '生成失败');
}

async function onSubmit(e) {
  e.preventDefault();
  if (state.busy) return;
  if (!state.loggedIn) {
    notice('请先 <a href="account.html">登录</a> 后再生成。', 'warn');
    return;
  }
  const sku = state.sku;
  if (!sku) return;
  const { payload, error } = readInput(sku);
  if (error) {
    showToast(error);
    return;
  }
  if (!(await ensureAdult({ action: KIND_TITLE[sku] || '生成报告' }))) return;

  const btn = $('btn-generate');
  const label = btn.textContent;
  state.busy = true;
  btn.disabled = true;
  btn.innerHTML = '<span class="advice-spinner"></span>生成中…';
  $('generate-hint').textContent = '';
  clearNotices();
  try {
    let report = await api.generateReport({ sku, payload, idempotencyKey: api.newIdempotencyKey() });
    if (report?.status === 'pending') {
      // 付费报告会做"内容量守卫"：首稿偏短时带着上一稿扩写，最坏 3 次调用 ≈ 2 分钟。
      // 客户端等待上限必须大于这个值（服务端 pending 兜底是 5 分钟），否则用户会看到
      // "生成超时"，而报告其实几秒后就出来了 —— 这是最容易招来客诉的一种体验。
      report = await api.waitForReport(report.reportId, {
        timeoutMs: 180000,
        onTick: (ms) => {
          btn.innerHTML = `<span class="advice-spinner"></span>生成中… ${Math.round(ms / 1000)}s（内容较长，通常 30–120 秒）`;
        },
      });
    }
    state.report = report;
    state.shareToken = null;
    renderReport(report);
    try {
      track('report_generated', { sku, kind: report?.kind || sku, completeness: report?.completeness ?? null });
    } catch {
      /* 埋点永不打断主流程 */
    }
    showToast(report?.billing?.charged > 0 ? `已生成 · 已扣 ¥${report.billing.charged}` : '报告已生成');
    loadSkus();
    loadList();
  } catch (err) {
    handleError(err);
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.textContent = label;
    $('generate-hint').textContent = '';
  }
}

// ---------------------------------------------------------------- 展示

function listHtml(items, ordered) {
  if (!items?.length) return '';
  return `<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`;
}

function renderReport(report) {
  const sec = report?.sections || {};
  const kind = report?.kind || state.sku || 'diagnose';
  $('panel-result').classList.remove('hidden');
  $('result-title').textContent = `${KIND_TITLE[kind] || '报告'} · ${fmtDate(report?.createdAt)}`;

  const summary = sec.summary || String(report?.content || '').split('\n')[0] || '';
  const parts = [];
  if (summary) parts.push(`<div class="advice-summary">${escapeHtml(summary)}</div>`);
  if (sec.risks?.length) parts.push(`<div class="advice-block"><h3>风险点</h3>${listHtml(sec.risks, false)}</div>`);
  if (sec.cases?.length) parts.push(`<div class="advice-block"><h3>对照案例</h3>${listHtml(sec.cases, false)}</div>`);
  if (sec.actions?.length) parts.push(`<div class="advice-block"><h3>行动清单</h3>${listHtml(sec.actions, true)}</div>`);
  if (!parts.length) parts.push(`<div class="advice-block"><p>${escapeHtml(String(report?.content || '').slice(0, 1200))}</p></div>`);

  const meta = [];
  if (typeof report?.completeness === 'number') meta.push(`结构完整度 ${(report.completeness * 100).toFixed(0)}%`);
  if (report?.fallback) meta.push('本次由兜底文案生成');
  if (report?.retrieval) meta.push(`案例检索：${report.retrieval === 'vector' ? '语义向量' : '关键词'}`);
  if (report?.scenes?.length) meta.push(`场景：${report.scenes.join('、')}`);
  if (meta.length) parts.push(`<p class="advice-meta">${escapeHtml(meta.join(' · '))}</p>`);

  $('advice-body').innerHTML = parts.join('');
  $('panel-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- 分享（T2.4）

/** 取（或签发）分享 token；短链 `/r/<token>` 就是二维码的内容 */
async function ensureShareToken() {
  if (state.shareToken) return state.shareToken;
  const id = state.report?.reportId || state.report?.id;
  if (!id) throw new Error('报告还没准备好');
  const data = await api.shareReport(id);
  state.shareToken = data.shareToken;
  return state.shareToken;
}

function shortUrl(token) {
  return api.absoluteUrl(`/r/${token}`);
}

async function onSaveCard() {
  const btn = $('btn-share-card');
  if (!state.report) return;
  btn.disabled = true;
  const label = btn.textContent;
  btn.innerHTML = '<span class="advice-spinner"></span>出图中…';
  try {
    const token = await ensureShareToken();
    const res = await downloadAdviceCard(state.report, { shareUrl: shortUrl(token) });
    if (res.ok) {
      try {
        track('share_card_save', { sku: state.sku, kind: state.report?.kind || state.sku });
      } catch {
        /* 埋点永不打断主流程 */
      }
      showToast('分享卡已开始下载，可直接发朋友圈');
    } else {
      showToast(res.error || '出图失败');
    }
  } catch (err) {
    showToast(err?.message || '出图失败');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function onShareLink() {
  const btn = $('btn-share-link');
  btn.disabled = true;
  try {
    const token = await ensureShareToken();
    const url = shortUrl(token);
    (await copyText(url)) ? showToast('分享链接已复制（30 天内有效）') : showToast(url);
  } catch (err) {
    showToast(err?.message || '生成分享链接失败');
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- 列表

async function loadList() {
  if (!state.loggedIn) return;
  const box = $('advice-list-body');
  try {
    const items = await api.listMyReports(30);
    const mine = (items || []).filter((r) => r.kind === 'diagnose' || r.kind === 'retro');
    $('panel-list').classList.toggle('hidden', !mine.length);
    if (!mine.length) {
      box.innerHTML = '<div class="empty-state">还没有记录。</div>';
      return;
    }
    box.innerHTML = `<div class="advice-list">${mine
      .map(
        (r) => `<div class="advice-item" data-id="${escapeHtml(r.id)}">
          <span>${escapeHtml(KIND_TITLE[r.kind] || '报告')} · ${escapeHtml(fmtDate(r.createdAt))}</span>
          <span class="muted">${escapeHtml(String(r.sections?.summary || r.content || '').slice(0, 24) || '查看')}</span>
        </div>`,
      )
      .join('')}</div>`;
    box.querySelectorAll('.advice-item').forEach((el) => {
      el.addEventListener('click', async () => {
        el.style.opacity = '0.6';
        try {
          const full = await api.fetchReport(el.dataset.id);
          state.report = full;
          state.shareToken = null;
          state.sku = full.kind || 'diagnose';
          renderReport(full);
        } catch (err) {
          showToast(err?.message || '打开失败');
        } finally {
          el.style.opacity = '';
        }
      });
    });
  } catch (err) {
    box.innerHTML = `<div class="empty-state">${escapeHtml(err?.message || '加载失败')}</div>`;
  }
}

// ---------------------------------------------------------------- 初始化

async function loadSkus() {
  try {
    const data = await api.fetchReportSkus();
    state.skus = data?.skus || {};
    state.scenes = data?.scenes || {};
    state.billingOn = data?.billingOn;
    state.credits = data?.credits || null;
    renderSkuGrid();
  } catch (err) {
    if (err?.needLogin) {
      notice('请先 <a href="account.html">登录</a>：登录后才能查看价格与会员额度。', 'warn');
      $('sku-grid').innerHTML = '<div class="empty-state">登录后可查看价格。</div>';
      return;
    }
    $('sku-grid').innerHTML = `<div class="empty-state">${escapeHtml(err?.message || '价格加载失败')}</div>`;
  }
}

async function init() {
  state.loggedIn = isLoggedIn();
  $('btn-generate').addEventListener('click', () => {});
  $('advice-form').addEventListener('submit', onSubmit);
  $('btn-share-card').addEventListener('click', onSaveCard);
  $('btn-share-link').addEventListener('click', onShareLink);
  $('btn-again').addEventListener('click', () => {
    $('panel-result').classList.add('hidden');
    $('panel-input').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  try {
    track('report_landing_view', { page: 'advice' });
  } catch {
    /* 埋点永不打断主流程 */
  }

  if (!state.loggedIn) {
    notice('先 <a href="account.html">登录</a> 才能生成报告（需要账号来保存报告与分享链接）。', 'warn');
  }
  await loadSkus();
  loadList();

  // 落地页带来的 ?ch=xxx 已在 track.js 里持久化，这里只把 sku 预选出来
  const url = new URL(location.href);
  const want = url.searchParams.get('sku');
  if (want && state.skus[want]) chooseSku(want);
}

init();
