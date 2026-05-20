export function showLoading(text = 'Q智慧思考中…') {
  let el = document.getElementById('global-loading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'global-loading';
    el.className = 'global-loading';
    el.innerHTML = `<div class="global-loading-box"><div class="typing-indicator"><span></span><span></span><span></span></div><p class="loading-text"></p></div>`;
    document.body.appendChild(el);
  }
  el.querySelector('.loading-text').textContent = text;
  el.classList.add('show');
}

export function hideLoading() {
  document.getElementById('global-loading')?.classList.remove('show');
}
