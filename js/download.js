/**
 * 下载页渲染
 *
 * 2026-09-20 重写。原来这里只处理**手写的** `[data-dl]` 按钮，而下载页的 12 个入口
 * 在 `js/download-config.js` 里 href 全是空串 —— 于是页面上每个按钮点下去都是
 * 「即将上线」，看上去"有下载"、实际一个都拿不到（客户视角就是死胡同）。
 *
 * 现在：
 *   1. 页面结构由 `DOWNLOAD_SECTIONS` + `DOWNLOAD_LINKS` **数据驱动**渲染，
 *      加一个端只需改 release-links.json 并跑生成脚本，不用动 HTML；
 *   2. 没有链接的端渲染成**明确的不可用状态**（灰按钮 + 写明原因），
 *      而不是一个 href="#" 的假可点按钮；
 *   3. 有小程序码就显示二维码图，没有就显示占位（并说明"上传后显示"）。
 */
import { DOWNLOAD_LINKS, DOWNLOAD_SECTIONS } from './download-config.js';
import { showToast } from './app.js';

function el(tag, cls, html) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html != null) node.innerHTML = html;
  return node;
}

/** 纯文本转义（desc/note 里有来自客服配置的文本） */
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderCard(key) {
  const cfg = DOWNLOAD_LINKS[key];
  if (!cfg) return null;
  const card = el('article', 'download-card');
  card.id = `dl-${key}`;

  const iconHtml = cfg.kind === 'miniprogram'
    ? `<div class="download-icon" aria-hidden="true">${esc(cfg.icon)}</div>`
    : `<div class="download-icon" aria-hidden="true">${esc(cfg.icon)}</div>`;

  const href = cfg.href || cfg.store || '';
  const usable = !!(href || cfg.active);
  if (usable) card.classList.add('download-card-active');

  let actionHtml;
  if (usable) {
    const label = cfg.label;
    const target = /^https?:\/\//.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
    actionHtml = `<a class="btn ${cfg.kind === 'miniprogram' ? 'btn-secondary' : 'btn-primary'} btn-sm download-btn" href="${esc(href)}"${target}>${esc(label)}</a>`;
  } else {
    // 不可用状态：**不渲染 href**，避免"点了没反应"
    actionHtml = `<span class="btn btn-sm download-btn download-btn-disabled" role="button" aria-disabled="true" data-pending="${esc(key)}">即将上线</span>`;
  }

  let qrHtml = '';
  if (cfg.kind === 'miniprogram') {
    qrHtml = cfg.qrcode
      ? `<div class="download-qr"><img src="${esc(cfg.qrcode)}" alt="${esc(cfg.label)}小程序码" width="120" height="120" loading="lazy"></div>`
      : `<div class="download-qr-placeholder">小程序码<br>待上传</div>`;
  }

  // 小程序卡片显示 desc（"在哪搜"），App 卡片显示 note（上架渠道）
  const subHtml = cfg.kind === 'miniprogram'
    ? `<p class="download-desc">${esc(cfg.desc || '')}</p>`
    : `<p class="download-desc">${esc(cfg.note || '')}</p>`;

  card.innerHTML = `${iconHtml}<h3>${esc(cfg.label)}</h3>${subHtml}${actionHtml}${qrHtml}`;
  return card;
}

function render() {
  for (const section of DOWNLOAD_SECTIONS) {
    const grid = document.getElementById(`dl-grid-${section.keys[0]}`) || document.getElementById(`dl-grid-${section.title}`);
    // 找不到容器就用顺序定位（页面里三个 grid 依次是 桌面/App/小程序…）
    const target = grid || document.querySelectorAll('[data-dl-grid]')[DOWNLOAD_SECTIONS.indexOf(section)];
    if (!target) continue;
    target.innerHTML = '';
    for (const key of section.keys) {
      const card = renderCard(key);
      if (card) target.appendChild(card);
    }
  }

  // 待上线入口：点击给出**具体原因**，而不是干瘪的"即将上线"
  document.querySelectorAll('[data-pending]').forEach((node) => {
    node.addEventListener('click', () => {
      const key = node.dataset.pending;
      const cfg = DOWNLOAD_LINKS[key] || {};
      const why = cfg.note || cfg.desc || '该端口尚未发布';
      showToast(`${cfg.label || key}：${why}。可先使用网页版 qtvq.cn`, 3200);
    });
  });
}

render();
