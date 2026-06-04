import { apiFetch } from './api-fetch.js';
import { getClientId } from './quota.js';
import { showToast } from './toast.js';

const SUPPORT_EMAIL = 'qtvq@qtvq.cn';
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 400 * 1024;

let pendingImages = [];
let modalBound = false;
let delegationBound = false;

function ensureModal() {
  if (document.getElementById('contact-modal')) return;

  const modal = document.createElement('div');
  modal.id = 'contact-modal';
  modal.className = 'modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'contact-modal-title');
  modal.innerHTML = `
    <div class="modal-backdrop" data-close-contact tabindex="-1"></div>
    <div class="modal-box modal-box-wide contact-modal-box">
      <h3 id="contact-modal-title">联系客服 · ${SUPPORT_EMAIL}</h3>
      <p class="modal-hint">可发送文字说明与截图/图片（最多 ${MAX_IMAGES} 张，单张 400KB 内），提交后将<strong>自动发送至 qtvq@qtvq.cn 邮箱</strong>。请勿填写银行卡密码等敏感信息。</p>
      <form id="contact-form">
        <label>您的留言 <span class="label-required">*</span>
          <textarea name="message" rows="5" required maxlength="5000" placeholder="描述您的问题或建议…"></textarea>
        </label>
        <label>方便回复的邮箱（选填）
          <input type="email" name="replyEmail" maxlength="120" placeholder="you@example.com">
        </label>
        <label class="contact-upload-label">
          添加图片
          <input type="file" id="contact-images" accept="image/*" multiple hidden>
          <button type="button" class="btn btn-secondary btn-sm" id="btn-pick-images">选择图片</button>
        </label>
        <div id="contact-preview" class="contact-preview"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" data-close-contact>取消</button>
          <button type="submit" class="btn btn-primary">发送留言</button>
        </div>
      </form>
      <p class="modal-hint contact-mail-hint">也可直接发邮件至 <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>（邮件客户端可附图片）</p>
    </div>
  `;
  document.body.appendChild(modal);
}

function renderPreviews() {
  const box = document.getElementById('contact-preview');
  if (!box) return;
  box.innerHTML = '';
  pendingImages.forEach((item, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'contact-thumb';
    wrap.innerHTML = `<img src="${item.data}" alt=""><button type="button" class="contact-thumb-remove" data-i="${i}" aria-label="移除">×</button>`;
    box.appendChild(wrap);
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function addImages(files) {
  for (const file of files) {
    if (pendingImages.length >= MAX_IMAGES) {
      showToast(`最多 ${MAX_IMAGES} 张图片`);
      break;
    }
    if (!file.type.startsWith('image/')) continue;
    if (file.size > MAX_IMAGE_BYTES) {
      showToast(`${file.name} 超过 400KB，请压缩后重试`);
      continue;
    }
    const data = await readFileAsDataUrl(file);
    pendingImages.push({ name: file.name, type: file.type, data });
  }
  renderPreviews();
}

export function openContactModal() {
  ensureModal();
  pendingImages = [];
  renderPreviews();
  const form = document.getElementById('contact-form');
  form?.reset();
  const modal = document.getElementById('contact-modal');
  modal?.classList.add('open');
  modal?.querySelector('textarea')?.focus();
}

export function closeContactModal() {
  document.getElementById('contact-modal')?.classList.remove('open');
}

function bindModalEvents() {
  if (modalBound) return;
  const modal = document.getElementById('contact-modal');
  if (!modal) return;
  modalBound = true;

  modal.querySelectorAll('[data-close-contact]').forEach((el) => {
    el.addEventListener('click', closeContactModal);
  });

  document.getElementById('btn-pick-images')?.addEventListener('click', () => {
    document.getElementById('contact-images')?.click();
  });

  document.getElementById('contact-images')?.addEventListener('change', (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    addImages(files);
  });

  document.getElementById('contact-preview')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.contact-thumb-remove');
    if (!btn) return;
    pendingImages.splice(Number(btn.dataset.i), 1);
    renderPreviews();
  });

  document.getElementById('contact-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const message = String(fd.get('message') || '').trim();
    const replyEmail = String(fd.get('replyEmail') || '').trim();
    if (!message) {
      showToast('请填写留言');
      return;
    }

    const submitBtn = e.target.querySelector('[type="submit"]');
    submitBtn.disabled = true;
    try {
      const res = await apiFetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          replyEmail,
          clientId: getClientId(),
          images: pendingImages.map(({ name, type, data }) => ({ name, type, data })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '提交失败');
      showToast(data.message || '已提交，客服将尽快回复');
      closeContactModal();
    } catch (err) {
      showToast(err.message || '提交失败，请发邮件至 qtvq@qtvq.cn');
    } finally {
      submitBtn.disabled = false;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) {
      closeContactModal();
    }
  });
}

function bindOpenDelegation() {
  if (delegationBound) return;
  delegationBound = true;

  document.addEventListener('click', (ev) => {
    const trigger = ev.target.closest('[data-open-contact]');
    if (!trigger) return;
    ev.preventDefault();
    openContactModal();
  });
}

export function initContactModal() {
  ensureModal();
  bindModalEvents();
  bindOpenDelegation();
}
