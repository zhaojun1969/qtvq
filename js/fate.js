import { FATE_TYPES, PITFALLS } from './data.js';
import { getUser } from './app.js';

/** 根据提问与浏览记录推荐缘类型 */
export function recommendFateType() {
  const user = getUser();
  const scores = { straight: 0, safe: 0, slow: 0 };

  Object.entries(user.browseCategories || {}).forEach(([k, v]) => {
    if (['暧昧', '冷暴力'].includes(k)) scores.straight += v;
    if (['网恋', '彩礼'].includes(k)) scores.safe += v * 1.2;
    if (['见家长', '相亲'].includes(k)) scores.slow += v;
  });

  (user.questionHistory || []).forEach((q) => {
    if (/暧昧|确认|冷暴力/.test(q)) scores.straight += 2;
    if (/借钱|转账|投资|网恋/.test(q)) scores.safe += 2;
    if (/彩礼|家长|结婚|相亲/.test(q)) scores.slow += 2;
  });

  const read = JSON.parse(localStorage.getItem('qtvq_read') || '[]');
  read.forEach((id) => {
    const p = PITFALLS.find((x) => x.id === id);
    if (!p) return;
    if (p.category === '暧昧' || p.category === '冷暴力') scores.straight += 1;
    if (p.category === '网恋' || p.cost === '金钱') scores.safe += 1;
    if (p.category === '见家长' || p.category === '相亲') scores.slow += 1;
  });

  let best = 'straight';
  let max = scores.straight;
  Object.entries(scores).forEach(([k, v]) => {
    if (v > max) {
      max = v;
      best = k;
    }
  });

  return FATE_TYPES.find((t) => t.id === best) || FATE_TYPES[0];
}

export function buildFateCardText() {
  const read = JSON.parse(localStorage.getItem('qtvq_read') || '[]');
  const titles = read
    .slice(0, 5)
    .map((id) => PITFALLS.find((p) => p.id === id)?.title)
    .filter(Boolean);
  const type = recommendFateType();
  const learned = titles.length
    ? titles.map((t) => `· ${t}`).join('\n')
    : '· 拒绝网恋借钱\n· 暧昧设期限\n· 冷暴力底线沟通';
  return `【缘分直线卡】\n类型：${type.name}\n我已学会避坑：\n${learned}\n欢迎直线沟通，一起避坑。\n—— 我心永恒-Q问 qtvq.cn`;
}
