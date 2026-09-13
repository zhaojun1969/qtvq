/**
 * 三维度打分：兴趣 / 性格 / 生活方式
 *
 * 设计原则：**确定性优先**。模型只负责写「人话」，分数由可复现的算法算出，
 * 否则同一个用户连点两次会看到不同的契合度，投诉与纠纷都从这里来。
 */
import { DIM_ZH } from '../constants.js';
import { cosine } from './embed.js';

function clamp01(x) {
  if (!Number.isFinite(x)) return 0.5;
  return Math.max(0, Math.min(1, x));
}

/** Jaccard 相似度；任一为空返回中性值 0.5，避免「没填资料=0 分」的挫败感 */
export function jaccard(a = [], b = []) {
  const sa = new Set((a || []).map((x) => String(x).trim()).filter(Boolean));
  const sb = new Set((b || []).map((x) => String(x).trim()).filter(Boolean));
  if (!sa.size || !sb.size) return 0.5;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = new Set([...sa, ...sb]).size;
  return union ? inter / union : 0.5;
}

export function cityScore(a, b) {
  if (!a || !b) return 0.5;
  if (a === b) return 1;
  const sameProvince = { 北京: '华北', 天津: '华北', 上海: '华东', 杭州: '华东', 南京: '华东', 广州: '华南', 深圳: '华南', 成都: '西南', 重庆: '西南' };
  if (sameProvince[a] && sameProvince[a] === sameProvince[b]) return 0.75;
  return 0.55;
}

export function ageScore(a, b) {
  if (!a || !b) return 0.5;
  const gap = Math.abs(Number(a) - Number(b));
  if (!Number.isFinite(gap)) return 0.5;
  return clamp01(1 - gap / 15);
}

/**
 * @param {object} me  我方用户文档（含 profileVector / introVector / tags / city / age）
 * @param {object} ta  对方用户文档
 * @param {string[]} dims 需要计算的维度（按档位裁剪）
 * @returns {{scores: Record<string, number>, overall: number, basis: Record<string, string>}}
 */
export function scoreDimensions(me, ta, dims) {
  const scores = {};
  const basis = {};

  // 兴趣：标签 Jaccard 为主，向量情绪为辅（有向量时按 6:4 融合）
  let interest = jaccard(me.tags, ta.tags);
  basis.interest = `标签重合度 ${(interest * 100).toFixed(0)}%`;
  if (me.profileVector && ta.profileVector) {
    const v = clamp01((cosine(me.profileVector, ta.profileVector) + 1) / 2);
    interest = interest * 0.6 + v * 0.4;
    basis.interest += `；资料向量相似度 ${(v * 100).toFixed(0)}%`;
  }

  // 性格：优先用「简介」向量；无向量时退化为字面重合
  let personality = 0.5;
  if (me.introVector && ta.introVector) {
    const v = clamp01((cosine(me.introVector, ta.introVector) + 1) / 2);
    personality = 0.3 + v * 0.7; // 加 0.3 底噪，避免同一维度分数过低
    basis.personality = `自我介绍语义相似度 ${(v * 100).toFixed(0)}%`;
  } else if (me.intro && ta.intro) {
    const sa = new Set(me.intro);
    const sb = new Set(ta.intro);
    let inter = 0;
    for (const ch of sa) if (sb.has(ch)) inter++;
    personality = clamp01(inter / Math.max(sa.size, sb.size));
    basis.personality = `自我介绍字面重合（未启用向量）`;
  } else {
    basis.personality = `资料不足，取中性值`;
  }

  // 生活方式：城市 + 年龄带
  const c = cityScore(me.city, ta.city);
  const a = ageScore(me.age, ta.age);
  const lifestyle = clamp01(c * 0.6 + a * 0.4);
  basis.lifestyle = `城市 ${c === 1 ? '同城' : c >= 0.75 ? '邻近' : '异地'}；年龄差 ${Math.abs((me.age || 0) - (ta.age || 0)) || '未知'} 岁`;

  const computed = { interest, personality, lifestyle };
  for (const d of dims) {
    scores[d] = Number(clamp01(computed[d] ?? 0.5).toFixed(3));
  }

  const values = dims.map((d) => scores[d]);
  const overall = Number((values.reduce((s, x) => s + x, 0) / (values.length || 1)).toFixed(3));

  return {
    scores,
    overall,
    basis,
    labels: Object.fromEntries(dims.map((d) => [d, DIM_ZH[d] || d])),
  };
}
