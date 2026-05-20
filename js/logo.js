/** 统一 Logo SVG：圆环蓝、∞紫、问号绿、爱心红 */
export const LOGO_SVG = `<svg class="logo-icon" viewBox="0 0 64 64" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <!-- 圆框：蓝 -->
    <circle class="logo-ring" cx="32" cy="34" r="15.5" stroke="#2196F3" stroke-width="2.15"/>
    <!-- 无穷大：紫 -->
    <path class="logo-infinity" stroke="#9C27B0" stroke-width="2.15" d="M 25 31.5 C 25 29.6 28 28.6 32 31.5 C 36 34.4 39 33.4 39 31.5 C 39 29.6 36 28.6 32 31.5 C 28 34.4 25 33.4 25 31.5 Z"/>
    <!-- 中心 Q：橙金点缀 -->
    <text class="logo-q" x="32" y="33.5" text-anchor="middle" fill="#FF9800" stroke="none" font-size="12" font-weight="bold">Q</text>
    <!-- 问号：绿 -->
    <g class="logo-symbol logo-qmark">
      <circle cx="32" cy="38.5" r="2.9" fill="#00C853" stroke="none"/>
      <path stroke="#00C853" stroke-width="2.15" d="M 29.5 40.5 C 27.8 44.2 32 46.2 34.5 44.5 C 36.2 43.2 36.2 41.5 35 40.5 L 32 45"/>
    </g>
    <!-- 爱心：红 -->
    <g class="logo-symbol logo-heart">
      <path fill="#F44336" stroke="none" d="M 40 30.5 C 40 28.5 38.2 27.5 37 29 C 35.8 27.5 34 28.5 34 30.5 C 34 32.5 37 35 37 35 C 37 35 40 32.5 40 30.5 Z"/>
    </g>
  </g>
</svg>`;

export function mountLogo() {
  document.querySelectorAll('[data-logo]').forEach((el) => {
    el.innerHTML = LOGO_SVG;
  });
}
