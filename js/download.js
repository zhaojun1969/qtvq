import { DOWNLOAD_LINKS } from './download-config.js';
import { showToast } from './app.js';

function applyDownloadLinks() {
  document.querySelectorAll('[data-dl]').forEach((btn) => {
    const key = btn.dataset.dl;
    const cfg = DOWNLOAD_LINKS[key];
    if (!cfg) return;

    const href = cfg.href || cfg.store || '';
    if (href) {
      btn.href = href;
      btn.textContent = cfg.label || btn.dataset.label || '立即下载';
      btn.classList.remove('download-btn-disabled');
      if (href.startsWith('http')) {
        btn.target = '_blank';
        btn.rel = 'noopener noreferrer';
      }
    } else {
      btn.href = '#';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        showToast('该端口即将上线，请先用浏览器打开 qtvq.cn');
      });
    }
  });

  document.querySelectorAll('[data-qr]').forEach((box) => {
    const key = box.dataset.qr;
    const qr = DOWNLOAD_LINKS[key]?.qrcode;
    if (qr) {
      box.innerHTML = `<img src="${qr}" alt="${key} 小程序码" width="120" height="120">`;
    }
  });
}

applyDownloadLinks();
