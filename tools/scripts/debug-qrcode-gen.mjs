/** 真机扫码验证材料生成：为指定账号出体验版小程序码（scene=短码，真机验证归因用） */
import process from 'node:process';
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:3000';
const { connectDB, getDB } = await import('/opt/qtvq/server/src/config/db.js');
await connectDB();
const db = getDB();

const targets = process.argv.slice(2); // 传 userId 列表；不传则取两个疑似业务方账号
const uids = targets.length ? targets : ['u_mu3g3la8_fc9de833', 'u_d5e4f894f3834354b5a6'];

fs.mkdirSync('/tmp/qtvq-qr', { recursive: true });
for (const uid of uids) {
  const { ensureShortCode } = await import('/opt/qtvq/server/src/services/shortcodes.js');
  const code = await ensureShortCode(uid);
  const { getMiniProgramCode } = await import('/opt/qtvq/server/src/services/wechat-pay.js');
  const r = await getMiniProgramCode({ shortCode: code, channel: 'trialtest', envVersion: 'trial' });
  if (!r.ok) {
    console.log(`${uid} 短码=${code} → 出图失败: ${r.error}`);
    continue;
  }
  const f = `/tmp/qtvq-qr/trial-${code}.png`;
  fs.writeFileSync(f, r.buffer);
  console.log(`${uid} → 短码 ${code} → ${f}（体验版码，${r.buffer.length}B）`);
}
console.log('\n使用说明：把 PNG 发到手机 → 微信扫码 → 打开体验版 → 进入首页即完成归因；');
console.log('注册时 attributionPayload 自动带 inviterUid → 验证 users.acquisition 与邀请券。');
process.exit(0);
