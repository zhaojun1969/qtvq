/**
 * 分享落地页 `/r/<token>`（实施书 P2-T2.4）
 *
 * nginx 把 `/r/<token>` 重写成 `/r.html?t=<token>`（见 deploy/hardening/nginx/qtvq-server-snippet.conf），
 * 页面再用公开接口 `GET /v1/report/share/:token` 拉摘要。
 *
 * 为什么不把报告渲染成服务端 HTML：
 *   · 服务端 HTML 要么缓存（会泄漏内容）、要么每次回源（2C4G 的机器上不划算）；
 *   · 这个页面天然是浏览器在看，拉一个 JSON 再渲染最省事，且分享者改内容不用重新发链接。
 *
 * 归因：落地即打 `share_card_landing`（ch=report_share + inviter），
 * 与分享卡片上的二维码是同一个 token —— 从卡片到落地页到注册是一条可查的链路。
 */
import { track } from './track.js';
import { fetchSharedReport } from './report-api.js';
import { isLoggedIn } from './auth.js';

const $ = (id) => document.getElementById(id);

const KIND_TITLE = { diagnose: '避坑诊断', retro: '关系复盘', pair: '配对报告' };

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function listHtml(items, ordered) {
  if (!items?.length) return '';
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag}>${items.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</${tag}>`;
}

function showError(text) {
  $('panel-error').hidden = false;
  $('panel-shared').hidden = true;
  $('error-text').textContent = text;
}

async function init() {
  const url = new URL(location.href);
  const token = (url.searchParams.get('t') || url.searchParams.get('token') || '').trim();
  if (!token) {
    showError('链接不完整（缺少分享码）。可以让朋友重新生成一次分享链接。');
    return;
  }

  let data;
  try {
    data = await fetchSharedReport(token);
  } catch (err) {
    const msg = err?.code === 'E_SHARE_EXPIRED'
      ? '这个分享链接已经过期（有效期 30 天）。'
      : err?.message || '分享链接不存在或已失效。';
    showError(msg);
    return;
  }

  // 归因落地：把邀请人 uid 存下来，等这个人真注册时随注册接口一起上报。
  // 只存 uid + 时间戳，不存昵称/手机号 —— 邀请奖励只需要知道"是谁邀请的"。
  if (data?.inviterUid) {
    try {
      localStorage.setItem('qtvq_inviter', JSON.stringify({ uid: data.inviterUid, at: Date.now(), from: 'share' }));
    } catch {
      /* 隐私模式下存不了就只做本次会话的埋点 */
    }
  }

  try {
    track('share_card_landing', {
      ch: 'report_share',
      kind: data?.kind || null,
      inviter: data?.inviterUid || null,
      // 只上报 token 前缀：足够去重，又不至于把完整凭证写进事件表
      tokenPrefix: token.slice(0, 6),
      loggedIn: isLoggedIn(),
    });
  } catch {
    /* 埋点永不打断主流程 */
  }

  const kind = data?.kind || 'diagnose';
  const kindZh = KIND_TITLE[kind] || '报告';
  const from = data?.inviterNickname ? `${data.inviterNickname} 的${kindZh}` : `朋友分享的${kindZh}`;
  $('landing-title').textContent = from;
  $('landing-sub').textContent = 'Q问 · 用真实避坑案例说话的 AI 情感顾问';

  const parts = [];
  if (data?.summary) parts.push(`<div class="advice-summary">${escapeHtml(data.summary)}</div>`);
  if (data?.risks?.length) parts.push(`<div class="advice-block"><h3>风险点</h3>${listHtml(data.risks, false)}</div>`);
  if (data?.cases?.length) parts.push(`<div class="advice-block"><h3>对照案例</h3>${listHtml(data.cases, false)}</div>`);
  if (data?.actions?.length) parts.push(`<div class="advice-block"><h3>行动清单</h3>${listHtml(data.actions, true)}</div>`);
  if (data?.pitfalls?.length) {
    parts.push(
      `<div class="advice-block"><h3>涉及的避坑案例</h3><ul>${data.pitfalls
        .map((p) => `<li>${escapeHtml(p.title || '')}${p.category ? `（${escapeHtml(p.category)}）` : ''}</li>`)
        .join('')}</ul></div>`,
    );
  }
  const meta = [];
  if (typeof data?.completeness === 'number') meta.push(`结构完整度 ${(data.completeness * 100).toFixed(0)}%`);
  if (data?.expiresAt) meta.push(`链接有效期至 ${String(data.expiresAt).slice(0, 10)}`);
  if (meta.length) parts.push(`<p class="advice-meta">${escapeHtml(meta.join(' · '))}</p>`);

  if (!parts.length) parts.push('<p class="panel-hint">这份报告没有可展示的摘要。</p>');
  $('shared-body').innerHTML = parts.join('');
  $('panel-shared').hidden = false;

  // CTA 按报告种类分流：诊断/复盘 → 自己测一次；配对 → 自己去配对
  const cta = $('btn-cta');
  if (kind === 'pair') {
    cta.href = 'report.html?ch=report_share';
    cta.textContent = '我也做一次配对 →';
  } else {
    cta.href = `advice.html?sku=${encodeURIComponent(kind)}&ch=report_share`;
    cta.textContent = '我也要一份 →';
  }
}

init();
