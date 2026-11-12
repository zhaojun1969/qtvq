/**
 * API 源站。
 *
 * 生产优先走**直连 Pages**（2026-10-26 方案 A），而不是经过河源 ECS 中转：
 *
 *   现在（慢）：浏览器 → Cloudflare(LAX) → 河源 ECS nginx → Cloudflare Pages(LAX) → Functions
 *   目标（快）：浏览器 → Cloudflare → Pages Functions
 *
 * 为什么改：实测（附录 E.14）那条「客户端→CF→ECS→又回 CF」的链路让每次 API 调用
 * 多付 **0.6–7.4 秒**；而客户端直连 pages.dev 实测仅 **0.94s**（同源路径 2.9s）。
 * 注意慢的从来不是 Pages，而是 **ECS↔Pages 那一段**，浏览器根本不需要它。
 *
 * 候选与选择策略
 * --------------
 *   ① `https://api.qtvq.cn`     —— 理想形态（无 ECS 中转，且域名属于本站）
 *   ② `https://qtvq-api.pages.dev` —— 兜底，无需任何 DNS 改动，今天就能用
 *
 * 每次页面加载后台**并行探测**两个候选，取「成功且最快（<1500ms）」的那个存进
 * localStorage；都不达标就清空 → 退回同源（原行为）。
 * 这样：DNS 未就绪时自动用 pages.dev；两个都慢/都不通时自动退回现状，页面不会白屏。
 */
export const DIRECT_CANDIDATES = ['https://api.qtvq.cn', 'https://qtvq-api.pages.dev'];

const DIRECT_FLAG_KEY = 'qtvq_api_direct_origin';

/**
 * 探测上限：超过这个耗时说明网络整体很差，任何候选都不值得选，退回同源默认值。
 *
 * 刻意**不用绝对阈值**（例如"<1500ms 才切"）：实测 pages.dev 在 1.0–1.9s 波动，
 * 固定阈值会让它在略慢时切换失败、白白退回更慢的同源路径。
 * 改为**三方同场竞速取最快**（api.qtvq.cn / pages.dev / 同源），
 * 网络好时自然选到最快的，网络差时谁都赢不了就保持同源。
 */
export const PROBE_MAX_MS = 4000;

function readDirectOrigin() {
  try {
    const v = localStorage.getItem(DIRECT_FLAG_KEY);
    return v && DIRECT_CANDIDATES.includes(v) ? v : '';
  } catch {
    return '';
  }
}

/** 由探测结果决定**下次加载**使用哪个直连源站；传空字符串表示退回同源 */
export function setDirectOrigin(origin) {
  try {
    if (origin && DIRECT_CANDIDATES.includes(origin)) localStorage.setItem(DIRECT_FLAG_KEY, origin);
    else localStorage.removeItem(DIRECT_FLAG_KEY);
  } catch {
    /* 隐私模式下写不了，退回同源即可 */
  }
}

export const API_ORIGIN = (() => {
  if (typeof location === 'undefined') return 'https://qtvq-api.pages.dev';
  const { hostname, port, origin } = location;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || port === '8788' || origin.includes('qtvq-api.pages.dev')) {
    return '';
  }
  // 生产（qtvq.cn）：只有探测选出了可用直连源站才切换，否则同源（现状）
  return readDirectOrigin();
})();

/** pages.dev 源站（也是候选之一，保留导出供 failover 使用） */
export const CROSS_ORIGIN = 'https://qtvq-api.pages.dev';

/**
 * 阿里云 OSS 备份读地址（Cloudflare 慢/不可用时降级）
 * 与 obs.env 中 OSS_BUCKET + OSS_BACKUP_PREFIX 对应，backup/api 建议公共读
 */
export const BACKUP_ORIGIN = (() => {
  if (typeof location === 'undefined') return 'https://qtvq.oss-cn-beijing.aliyuncs.com/qtvq/backup';
  return 'https://qtvq.oss-cn-beijing.aliyuncs.com/qtvq/backup';
})();

/**
 * 图片资源域名（2026-10-26）。
 *
 * 目标不是降延迟，而是**卸载源站带宽**：收款码单张 139 KB，源站只有 5 Mbps 固定带宽。
 *
 * 实测（同一客户端，各 6 次中位）：
 *   · 源站 qtvq.cn            CSS 0.121s / 图片 0.126s
 *   · static.qtvq.cn (Pages)  CSS 0.836s / 图片 1.045s
 * 即 Pages 对国内用户**慢 7–9 倍**。所以**只把图片**放过去 —— 图片在支付弹窗里
 * `loading="lazy"`，代价只落在"打开弹窗"这一刻，而带宽卸载是实打实的。
 * HTML/CSS/JS 仍走源站，保证首屏不受影响。
 *
 * 想回滚：把 IMG_BASE 改成 ''（imgUrl 会自动退回相对路径，即源站）。
 */
export const IMG_BASE = 'https://static.qtvq.cn';

/** @param {string} path 相对路径，如 assets/payment/qr-wechat.png */
export function imgUrl(path) {
  const p = String(path || '');
  if (!p || /^(https?:)?\/\//.test(p) || p.startsWith('data:')) return p;
  const rel = p.startsWith('/') ? p.slice(1) : p;
  return IMG_BASE ? `${IMG_BASE.replace(/\/$/, '')}/${rel}` : `/${rel}`;
}

/** @param {string} path 以 / 开头的路径，如 /api/chat */
export function apiUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  /* E.82：/v1/* 只存在于 qtvq.cn（nginx 反代到境内 Node）——api.qtvq.cn 与
   * pages.dev 都是 Pages 域，没有 /v1 路由。直连加速只属于 /api/*，
   * /v1 一律走同源，否则钱包/报告等在直连模式下全是 404"网络错误"
   * （2026-11-04 UI 实测：缘值余额读取失败即此根因）。 */
  if (p.startsWith('/v1/') || p === '/v1') return p;
  return `${API_ORIGIN}${p}`;
}
