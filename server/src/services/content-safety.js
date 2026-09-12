/**
 * 内容安全
 *
 * 三层设计，本地词表**始终生效**，外部服务可选：
 *   1. 本地词表 + 正则（本文件）—— 零成本、无延迟、必过；覆盖涉黄/涉赌/涉毒/诈骗/引流/辱骂
 *   2. 微信安全接口 `msg_sec_check`（可选，需 WECHAT_MINI_APPID/SECRET）
 *   3. 阿里云内容安全（**未实现**，需要持牌服务与 AccessKey 签名；留作升级路径，不做假的占位实现）
 *
 * 两点刻意的取舍：
 * - **不内置涉政词表**。涉政内容审核必须交给持牌内容安全服务，手工词表既不完整又会误伤；
 *   假装覆盖了反而是更大的风险。已在 README 写明这是已知缺口。
 * - **规范化后比对**。绕过词表最常见的手法就是插零宽字符或空格（"加 微 信"、"加*微*信"），
 *   所以除了原文比对，还会把非字母数字汉字全部压掉再比一次。
 *
 * 现状说明：小程序的 `msgSecCheck` 是给**小程序内**提交内容用的，用网站内容去校验属于灰色用法。
 * 正式上线建议接阿里云内容安全，本文件的 provider 结构就是为它预留的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';
import { ApiError } from '../lib/http.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.resolve(HERE, '../../data/sensitive-words.json');

// 必须给 'pass' 一个数字：`x > undefined` 恒为 false，
// 少了这一项会导致命中词表后 action 永远停留在 'pass'（内容查出来了却拦不住）。
const SEVERITY_ORDER = { pass: 0, review: 1, block: 2 };

let dict = null;

function loadDict() {
  if (dict) return dict;
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const words = [];
    for (const [category, conf] of Object.entries(raw.categories || {})) {
      for (const w of conf.words || []) {
        words.push({ word: w, category, severity: conf.severity || 'block', squashed: squash(w) });
      }
    }
    const patterns = (raw.patterns || []).map((p) => ({
      name: p.name,
      category: p.category,
      severity: p.severity || 'block',
      regex: new RegExp(p.regex, 'gi'),
    }));
    dict = { words, patterns, version: raw.version || 0, note: raw.note || '' };
    console.log(`[safety] 词表已加载：${words.length} 个词 / ${patterns.length} 条正则（v${dict.version}）`);
  } catch (err) {
    console.error('[safety] 词表加载失败，将只做正则与长度校验：', err.message);
    dict = { words: [], patterns: [], version: 0 };
  }
  return dict;
}

/** 去掉零宽与全角差异 */
function normalize(s) {
  return String(s ?? '')
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

/** 再压掉所有非字母数字汉字，用来对抗 "加 微 信" / "加*微*信" 这类绕过 */
function squash(s) {
  return normalize(s).replace(/[^0-9a-z\u4e00-\u9fa5]/g, '');
}

/** 不同字段的处置策略：资料里出现引流直接拒，提问里出现只标记待审 */
const POLICY = {
  profile: { 涉黄: 'block', 涉赌: 'block', 涉毒: 'block', 诈骗: 'block', 引流: 'block', 辱骂: 'review' },
  question: { 涉黄: 'block', 涉赌: 'block', 涉毒: 'block', 诈骗: 'block', 引流: 'review', 辱骂: 'review' },
  moderation: { 涉黄: 'review', 涉赌: 'review', 涉毒: 'review', 诈骗: 'review', 引流: 'review', 辱骂: 'review' },
  default: { 涉黄: 'review', 涉赌: 'review', 涉毒: 'review', 诈骗: 'review', 引流: 'review', 辱骂: 'review' },
};

function policyFor(field) {
  return POLICY[field] || POLICY.default;
}

/** 纯本地检查（同步、无网络） */
export function localCheck(text, { field = 'default' } = {}) {
  const d = loadDict();
  const raw = String(text ?? '');
  if (!raw.trim()) return { clean: true, hits: [], action: 'pass', provider: 'local' };

  const norm = normalize(raw);
  const sq = squash(raw);
  const policy = policyFor(field);
  const hits = [];

  for (const item of d.words) {
    const matched = norm.includes(item.word) || (item.squashed && sq.includes(item.squashed));
    if (!matched) continue;
    const severity = policy[item.category] || item.severity;
    hits.push({ kind: 'word', word: item.word, category: item.category, severity });
  }

  for (const p of d.patterns) {
    p.regex.lastIndex = 0;
    const m = p.regex.exec(raw);
    if (!m) continue;
    hits.push({
      kind: 'pattern',
      word: p.name,
      // 不回显命中内容，避免把用户手机号又写回日志/响应里
      category: p.category,
      severity: policy[p.category] || p.severity,
    });
  }

  // 同一类别只留一条，避免响应里出现几十个重复项
  const seen = new Set();
  const unique = [];
  for (const h of hits) {
    const k = `${h.category}:${h.word}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(h);
  }

  const action = unique.reduce(
    (acc, h) => (SEVERITY_ORDER[h.severity] > SEVERITY_ORDER[acc] ? h.severity : acc),
    'pass',
  );

  return {
    clean: unique.length === 0,
    hits: unique.slice(0, 6),
    categories: [...new Set(unique.map((h) => h.category))],
    action,
    provider: 'local',
  };
}

// ---------------------------------------------------------------- 微信安全接口（可选）

let wxToken = { value: null, expiresAt: 0 };

async function wechatAccessToken() {
  if (wxToken.value && wxToken.expiresAt > Date.now() + 60_000) return wxToken.value;
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(
    env.wechatMiniAppId,
  )}&secret=${encodeURIComponent(env.wechatMiniSecret)}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!json?.access_token) throw new Error(json?.errmsg || '获取 access_token 失败');
  wxToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in || 7200) * 1000 - 120_000 };
  return wxToken.value;
}

function isWechatConfigured() {
  return !!(env.wechatMiniAppId && env.wechatMiniSecret) && env.safetyProvider.includes('wechat');
}

async function wechatCheck(text) {
  const token = await wechatAccessToken();
  const url = `https://api.weixin.qq.com/wxa/msg_sec_check?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: String(text).slice(0, 2500), version: 1, scene: 2 }),
  });
  const json = await res.json();
  // 87014 = 内容含有违法违规内容
  if (json?.errcode === 87014) {
    return {
      clean: false,
      hits: [{ kind: 'provider', word: '微信安全接口', category: '违规内容', severity: 'block' }],
      categories: ['违规内容'],
      action: 'block',
      provider: 'wechat',
    };
  }
  if (json?.errcode && json.errcode !== 0) {
    throw new Error(`msg_sec_check 失败: ${json.errcode} ${json.errmsg}`);
  }
  return { clean: true, hits: [], categories: [], action: 'pass', provider: 'wechat' };
}

// ---------------------------------------------------------------- 对外统一入口

/**
 * 综合检查：本地必过，外部服务能查到问题就升级为 block。
 * **外部服务异常不阻塞业务**：只在日志留痕，按本地结果放行 —— 否则微信侧抖动会直接让用户存不了资料。
 */
export async function checkText(text, { field = 'default' } = {}) {
  const local = localCheck(text, { field });
  if (local.action === 'block') return local;

  if (isWechatConfigured()) {
    try {
      const remote = await wechatCheck(text);
      if (remote.action === 'block') return remote;
    } catch (err) {
      console.error('[safety] 微信内容检查失败（放行，按本地结果处理）:', err.message);
    }
  }
  return local;
}

/** 直接抛错版本，便于路由里一行接入 */
export async function assertSafe(text, { field = 'default', label = '内容' } = {}) {
  const r = await checkText(text, { field });
  if (r.action === 'block') {
    const cats = r.categories.join('、');
    // 必须抛 ApiError：errorHandler 只认 ApiError 的 status，普通 Error 会被当成 500
    const err = new ApiError(400, `${label}包含不允许的内容（${cats}），请修改后重试`, 'E_CONTENT_BLOCKED');
    err.safety = { categories: r.categories, hits: r.hits };
    throw err;
  }
  return r;
}

export function safetyStatus() {
  return {
    provider: env.safetyProvider,
    localWords: loadDict().words.length,
    localPatterns: loadDict().patterns.length,
    wechatConfigured: isWechatConfigured(),
    aliyunGreenImplemented: false,
  };
}
