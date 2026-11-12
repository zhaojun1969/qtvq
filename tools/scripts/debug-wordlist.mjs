/** 词表覆盖探测：样本文本 → checkText 本地词表结果；并列出词表内容 */
import process from 'node:process';
const { checkText } = await import('/opt/qtvq/server/src/services/content-safety.js');

const samples = [
  '加微信免费领取资料',
  '加 微 信 领 取',
  '博彩平台开户',
  '正常留言测试',
];
for (const s of samples) {
  const r = await checkText(s, { field: 'probe' });
  console.log(`[${s}] → ${JSON.stringify(r).slice(0, 160)}`);
}
process.exit(0);
