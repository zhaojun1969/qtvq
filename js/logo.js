/** 统一 Logo：圆环 + 圆内书法「问」+ 右下弯捺（Q 点） */
export const LOGO_SVG = `<svg class="logo-icon" viewBox="0 0 64 64" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="logoGradRing" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FF6B81"/>
      <stop offset="100%" stop-color="#6C5CE7"/>
    </linearGradient>
    <linearGradient id="logoGradWen" x1="20%" y1="100%" x2="80%" y2="0%">
      <stop offset="0%" stop-color="#FF6B81"/>
      <stop offset="100%" stop-color="#9C7AE8"/>
    </linearGradient>
  </defs>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <circle class="logo-ring" cx="32" cy="32" r="17" stroke="url(#logoGradRing)" stroke-width="2.4"/>
    <g class="logo-wen" stroke="url(#logoGradWen)" stroke-width="1.75">
      <path class="logo-wen-dot" d="M 37.2 18.8 Q 38.6 19.6 37 20.4 Q 35.8 19.8 37.2 18.8 Z" fill="url(#logoGradWen)" stroke="none"/>
      <path d="M 26.2 22.8 Q 25.4 31.5 26 40.2"/>
      <path d="M 37.5 23.2 Q 38.4 31.5 37.8 40"/>
      <path d="M 26.2 22.8 Q 32 20.2 37.5 23.2"/>
      <path d="M 28.8 30.2 Q 32 29.2 35.2 30.2 Q 35.8 32.2 35.1 34.2 Q 32 35.2 28.9 34.2 Q 28.2 32.2 28.8 30.2" fill="url(#logoGradWen)" fill-opacity="0.22" stroke="url(#logoGradWen)"/>
    </g>
    <path class="logo-q-tail" d="M 32 49 Q 40.5 51.2 49 49" stroke="#FF6B81" stroke-width="2.85" stroke-linecap="round"/>
  </g>
</svg>`;

export function mountLogo() {
  document.querySelectorAll('[data-logo]').forEach((el) => {
    el.innerHTML = LOGO_SVG;
  });
}
