/**
 * 阿里云内容安全（Green）连通性自检 —— `npm run diag:green`（在 server 目录）
 *
 * 为什么需要它：内容安全的失败方式全是"静默"的：
 *   · key 不对 → `SignatureDoesNotMatch`
 *   · 子账号没权限 → `Forbidden` / `NoPermission`
 *   · **服务没开通** → 各种 `ServiceNotOpened` 类错误（配额为 0）
 *   · 区域不对 → 时好时坏
 * 如果只看"检查没报错"，你会以为审核在跑，实际一次都没调通（**假安全**）。
 * 本脚本把上游返回的**原始错误码**打印出来，让人一眼看清是哪一类。
 *
 * 用法（服务器上）：
 *   cd /opt/qtvq/server && npm run diag:green
 */
import 'dotenv/config';
import { greenStatus, greenTextCheck, greenImageCheckByUrl, isGreenConfigured } from '../services/aliyun-green.js';

const line = (s = '') => console.log(s);

async function main() {
  const st = greenStatus();
  line('=== 阿里云内容安全（Green）自检 ===');
  line(`配置状态：${st.configured ? '已配置 ✅' : '未配置 ❌'}`);
  line(`  key 来源：${st.keySource}`);
  line(`  区域    ：${st.region}`);
  line(`  文本服务：${st.textService}`);
  line(`  图片服务：${st.imageService}`);
  line('');

  if (!isGreenConfigured()) {
    line('❌ 未配置，跳过连通性测试。');
    line('   在 server/.env 增加（建议用只授权内容安全的 RAM 子账号）：');
    line('     GREEN_ACCESS_KEY_ID=...');
    line('     GREEN_ACCESS_KEY_SECRET=...');
    line('     GREEN_REGION=cn-shanghai');
    line('   然后到阿里云控制台**开通内容安全服务**（未开通会返回配额为 0 类错误）。');
    process.exit(1);
  }

  // ① 文本审核：用一句明显违规的话，期望被判违规
  line('--- 文本审核（样本："这里可以赌博 加微信 xxx"）---');
  try {
    const r = await greenTextCheck('这里可以赌博 加微信 xxx');
    line(`  调用成功 ✅  clean=${r.clean}  riskLevel=${r.riskLevel}`);
    line(`  命中标签：${r.labels.length ? r.labels.join(', ') : '(无)'}`);
    line(`  映射类别：${r.categories.length ? r.categories.join('、') : '(无)'}`);
    if (r.clean) {
      line('  ⚠️ 明显违规的样本被判为"干净" —— 可能是服务未开通（返回空结果）或服务类型不对。');
      line('     请核对 GREEN_TEXT_SERVICE（默认 comment_detection）与控制台已开通的检测服务是否一致。');
    }
  } catch (err) {
    line(`  调用失败 ❌ ${err.message}`);
    line(`  上游错误码：${err.greenCode || '(无)'}`);
    line('  常见原因：');
    line('    InvalidApiKey / SignatureDoesNotMatch → AK/Secret 不是一对，或区域不对');
    line('    Forbidden / NoPermission             → RAM 子账号缺少内容安全权限');
    line('    ServiceNotOpened / NotActivated      → 内容安全服务未开通（控制台开通后才有配额）');
    line('    Throttling / QuotaExceeded           → 限流或配额用尽（充值/提额）');
  }

  // ② 图片审核：拿一个公开图片 URL 试（失败也要看清是哪一类）
  line('');
  line('--- 图片审核（样本：一张公开图）---');
  try {
    const r = await greenImageCheckByUrl('https://qtvq.cn/assets/logo.svg');
    line(`  调用成功 ✅  clean=${r.clean}  riskLevel=${r.riskLevel}  标签=${r.labels.join(',') || '(无)'}`);
  } catch (err) {
    line(`  调用失败 ❌ ${err.message}`);
    line(`  上游错误码：${err.greenCode || '(无)'}`);
    line('  注意：SVG 可能不被图片审核接口接受，这属正常；换成一张 JPG/PNG 的公开 URL 再试。');
  }

  line('');
  line('=== 自检结束 ===');
  line('提示：本服务**按调用量计费**，自检会产生极小额费用（每次几厘）。');
}

main().catch((err) => {
  console.error('自检脚本异常：', err);
  process.exit(1);
});
