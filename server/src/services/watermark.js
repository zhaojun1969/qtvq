/**
 * 文本水印 —— 用于「资料被人批量抓走后，溯源到是哪个账号抓的」。
 *
 * ── 为什么加在这里（业务方 2026-10-11 选定的 B 方案）────────────────────────
 * 产品里**没有**"查看联系方式"功能，联系方式在写入阶段就被拒收
 * （`server/src/routes/profile.js:45` 与 `:77`），`server/src/routes/report.js:266`
 * 也注明"只返回对方公开资料，不泄漏联系方式"。
 * 所以"给联系方式加水印 + 限流"**没有落点**。
 * 真正存在、且真的能被批量抓取的是**报告正文**与配对返回的对方资料 —— 水印加在这里才有意义。
 *
 * ── 设计取舍 ──────────────────────────────────────────────────────────────
 * · 用**零宽字符**编码"读者 uid"：肉眼与渲染都不可见，不影响阅读与排版，
 *   但被复制的文本会带着它一起走。标记的是**谁复制的**（而不是谁生成的）—— 这正是溯源需要的。
 * · 编码 uid 原文而非哈希：拿到泄漏文本即可直接定位账号，不需要额外查表。
 * · 同一段文本里放**两份**（中部 + 结尾）：只被复制走一部分的泄漏文本仍可溯源。
 * · ⚠️ 零宽字符会被某些编辑器/OCR/纯文本清洗掉 —— 所以它是**提高成本**的手段，不是绝对防线。
 *   真正的防线是读取频次上限（`server/src/middleware/read-limit.js`）：水印是事后取证，限流是事前阻断。
 */

// 零宽空格 / 零宽不连字符 —— 用来表示 0 / 1
const ZW = ['\u200b', '\u200c'];
// 起止哨兵：词连接符 / 不可见分隔符，正常中文文本里几乎不会出现，且肉眼不可见
const START = '\u2060\u2060';
const END = '\u2063\u2063';
// uid 最长 32 字节（`u_` + 30 个字符足够），超出直接拒绝，避免把长文本塞成水印
const MAX_BYTES = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

/** uid → 零宽字符串 */
export function encodeWatermark(uid) {
  const bytes = encoder.encode(String(uid)).slice(0, MAX_BYTES);
  let out = '';
  for (const b of bytes) {
    for (let i = 7; i >= 0; i -= 1) out += ZW[(b >> i) & 1];
  }
  return out;
}

/** 零宽字符串 → uid（解码失败返回 null，绝不抛错，避免把正常文本判成"有水印"） */
export function decodeWatermark(zw) {
  if (!zw || zw.length % 8 !== 0 || zw.length === 0) return null;
  const bytes = [];
  for (let i = 0; i < zw.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j += 1) {
      const idx = ZW.indexOf(zw[i + j]);
      if (idx === -1) return null;
      b = (b << 1) | idx;
    }
    bytes.push(b);
  }
  try {
    const s = decoder.decode(Uint8Array.from(bytes));
    // 只接受符合本项目 uid 形态的结果，避免把随机零宽噪声当成真水印
    return /^[A-Za-z0-9_:.-]{4,40}$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

/** 该文本里是否已有水印（幂等用） */
export function hasWatermark(text) {
  return typeof text === 'string' && text.includes(START) && text.includes(END);
}

/**
 * 给文本打上"读者标记"。
 * @param {string} text 原文
 * @param {string} uid  读者 uid（或 `ip:<地址>` 这类降级标识）
 * @returns {string} 打标后的文本（原文为空/uid 为空时原样返回）
 */
export function markText(text, uid) {
  if (typeof text !== 'string' || !text || !uid) return text;
  const wm = START + encodeWatermark(uid) + END;
  if (text.includes(wm)) return text; // 幂等：同一读者重复读取不会叠加

  // 中部插入点：取一半处之后最近的句末/换行，避免把词或句子从中间劈开（观感与 diff 都更干净）
  const mid = Math.floor(text.length / 2);
  let at = -1;
  for (const ch of ['\n', '。', '！', '？', '；', '.', '!', '?', ';']) {
    const i = text.indexOf(ch, mid);
    if (i !== -1 && (at === -1 || i < at)) at = i + 1;
  }
  if (at === -1) at = mid;

  return `${text.slice(0, at)}${wm}${text.slice(at)}${wm}`;
}

/**
 * 从一段（可能是泄漏出来的）文本里提取水印。
 * 一段文本可能含多个读者标记（例如被多人拼接），按出现顺序全部返回、去重。
 * @returns {string[]} uid 列表（无水印返回空数组）
 */
export function extractWatermarks(text) {
  if (typeof text !== 'string' || !text) return [];
  const found = [];
  const re = /\u2060\u2060([\u200b\u200c]*)\u2063\u2063/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const uid = decodeWatermark(m[1]);
    if (uid && !found.includes(uid)) found.push(uid);
  }
  return found;
}

/** 去掉水印（对外展示/二次处理前用，避免零宽字符进入下游系统） */
export function stripWatermark(text) {
  return typeof text === 'string' ? text.replace(/\u2060\u2060[\u200b\u200c]*\u2063\u2063/g, '') : text;
}

/**
 * 自检：往返、幂等、截断仍可溯源、不误伤正常文本。
 * 由 `tools/scripts/check-watermark.mjs` 调用（**每次改动水印实现都必须跑**）。
 */
export function selfTest() {
  const cases = [];
  const uid = 'u_3f9a2c7e81b04d5f';
  const src = '他性格偏内向，第一次见面建议选安静的咖啡馆。\n\n需要注意的是，他对迟到比较敏感。';

  const marked = markText(src, uid);
  cases.push(['往返：能解出原 uid', extractWatermarks(marked).includes(uid)]);
  cases.push(['不可见：去掉零宽后与原文完全一致', stripWatermark(marked) === src]);
  cases.push(['幂等：重复打标不叠加', markText(marked, uid) === marked]);
  cases.push(['多读者：两次打标能解出两个 uid',
    extractWatermarks(marked + markText('另一段', 'u_aaaaaaaaaaaaaaaa')).length === 2]);

  // 关键场景：泄漏者只复制了后半段（中部那份 + 结尾那份，至少有一份落在里面）
  const half = marked.slice(Math.floor(marked.length / 2));
  cases.push(['截断：只复制后半段仍可溯源', extractWatermarks(half).includes(uid)]);
  const firstHalf = marked.slice(0, Math.floor(marked.length / 2) + 200);
  cases.push(['截断：只复制前半段仍可溯源', extractWatermarks(firstHalf).includes(uid)]);

  cases.push(['不误伤：普通文本无水印', extractWatermarks(src).length === 0]);
  cases.push(['不误伤：纯零宽噪声不被当成 uid', extractWatermarks(START + '\u200b\u200b\u200b' + END).length === 0]);
  cases.push(['空值安全：空文本/空 uid 原样返回',
    markText('', uid) === '' && markText(src, '') === src && extractWatermarks('').length === 0]);

  return cases;
}
