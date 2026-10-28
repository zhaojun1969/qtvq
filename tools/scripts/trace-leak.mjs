/**
 * 泄漏溯源 —— 把一段"外流出来的报告文本"还原成"是哪个账号读走的"。
 *
 * 用法：
 *   node tools/scripts/trace-leak.mjs 疑似泄漏.txt
 *   type 疑似泄漏.txt | node tools/scripts/trace-leak.mjs
 *   node tools/scripts/trace-leak.mjs --check "粘贴一段文本"
 *
 * 原理：`server/src/services/watermark.js` 在每次**非本人**读取报告时，
 * 把读者 uid 用零宽字符编进正文（中部 + 结尾各一份，所以只被复制走一部分也能解出来）。
 * 这里把那些零宽字符解回 uid。拿到 uid 后用 `/v1/admin/...` 或直接查 `users` 集合即可定位账号。
 */
import fs from 'node:fs';
import { extractWatermarks, hasWatermark } from '../../server/src/services/watermark.js';

function readInput() {
  const args = process.argv.slice(2);
  if (args[0] === '--check') return args.slice(1).join(' ');
  if (args[0]) return fs.readFileSync(args[0], 'utf8');
  // 无参数：从标准输入读（便于管道）
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const text = readInput();
if (!text) {
  console.error('用法：node tools/scripts/trace-leak.mjs <文件>  |  … | node tools/scripts/trace-leak.mjs  |  --check "文本"');
  process.exit(2);
}

const uids = extractWatermarks(text);
console.log(`文本长度：${text.length} 字符，其中不可见水印字符：${(text.match(/[\u200b\u200c\u2060\u2063]/g) || []).length} 个`);
if (!hasWatermark(text)) {
  console.log('⚠️  未检测到水印标记。可能原因：① 这段文本不是从报告接口复制出来的；');
  console.log('    ② 中间经过了会清洗零宽字符的工具（微信/Word/OCR 都可能），水印已被抹掉。');
  process.exit(1);
}
if (uids.length === 0) {
  console.log('⚠️  有水印标记但解不出 uid —— 说明水印编码实现与当前版本不一致（或文本被部分破坏）。');
  process.exit(1);
}
console.log(`\n✅ 找到 ${uids.length} 个读者标记：`);
for (const uid of uids) console.log(`   ${uid}`);
console.log('\n提示：uid 形如 `u_xxx` 即为账号 id（Node 钱包 users._id 复用的就是它）；');
console.log('     形如 `ip:1.2.3.4` 表示该次读取未登录，只能定位到出口 IP。');
