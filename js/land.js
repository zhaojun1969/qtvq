/**
 * 落地页（land.html）—— 投放渠道的入口页
 *
 * 设计要点：
 * 1. **按渠道码换皮，不换结构**：`?ch=xhs01` → 换成该案例的标题/三条风险信号；
 *    码无效就退回通用文案（不能白屏，也不能空着 —— 投放链接经常被人手改错）。
 * 2. **渠道码必须透传**：主 CTA 指向 `advice.html?sku=diagnose&ch=<码>`，
 *    次 CTA 指向 `pitfalls.html?ch=<码>`；落地页只负责"带到正确的地方"，
 *    真正的渠道归因在注册时由 js/auth.js 的 acquisitionPayload() 上报。
 * 3. 埋两个点：`landing_view`（看了）与 `landing_cta_click`（点了）。
 *    两个分开埋是因为转化率 = 点击/曝光，混成一个事件就永远算不出来。
 */
import { landCase } from './land-cases.js';
import { track, channel } from './track.js';

/** 渠道码优先取 URL（投放链接带过来的），其次取本地已记住的渠道 */
function channelCode() {
  try {
    const url = new URL(window.location.href);
    const raw = (url.searchParams.get('ch') || url.searchParams.get('channel') || '').trim();
    if (raw) return raw.toLowerCase();
  } catch {
    /* URL 解析失败就当没有 */
  }
  const stored = channel();
  return stored && stored !== 'direct' ? stored : '';
}

function text(id, value) {
  const el = document.getElementById(id);
  if (el && value) el.textContent = value;
}

function appendChannel(href, ch) {
  if (!ch) return href;
  const sep = href.includes('?') ? '&' : '?';
  return `${href}${sep}ch=${encodeURIComponent(ch)}`;
}

function main() {
  const ch = channelCode();
  const item = landCase(ch);

  if (item) {
    // 有案例：标题用一句话主张（小红书标题偏长，手机上两行就够），风险信号换成本案的三条
    text('land-eyebrow', `${item.category} · 自查清单`);
    text('land-title', item.case);
    text('land-sub', item.hook);
    text('land-category', item.category);
    const ul = document.getElementById('land-signals');
    if (ul && Array.isArray(item.signals) && item.signals.length) {
      ul.innerHTML = '';
      for (const s of item.signals.slice(0, 3)) {
        const li = document.createElement('li');
        li.textContent = s;
        ul.appendChild(li);
      }
    }
    text('land-signals-note', '三条里中两条以上，就值得认真做一次结构性检查。');
    document.title = `${item.case} | 我心永恒 - Q问`;
  }

  const diagnose = document.getElementById('land-cta-diagnose');
  const pitfalls = document.getElementById('land-cta-pitfalls');
  if (diagnose) diagnose.href = appendChannel(diagnose.getAttribute('href') || 'advice.html?sku=diagnose', ch);
  if (pitfalls) pitfalls.href = appendChannel(pitfalls.getAttribute('href') || 'pitfalls.html', ch);

  track('landing_view', {
    ch: ch || 'none',
    case: item ? item.no : null,
    platform: item ? item.platform : null,
    path: window.location.pathname,
  });

  for (const [el, cta] of [
    [diagnose, 'diagnose'],
    [pitfalls, 'pitfalls'],
  ]) {
    if (!el) continue;
    el.addEventListener('click', () => {
      track('landing_cta_click', {
        ch: ch || 'none',
        cta,
        case: item ? item.no : null,
      });
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
