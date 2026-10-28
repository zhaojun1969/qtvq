/**
 * 一键跑完全部检查（本项目的"全面检查"入口）
 *
 * 为什么要有它：检查脚本已经有十来个，散在 `tools/scripts` 与 `apps/qtvq-uni/scripts` 下，
 * 每次改动"该跑哪几个"只能靠记 —— 而漏跑一个的后果是真实存在的
 * （漏跑 check-uni-wiring 就出现过"模板变量没声明、点下去才报错"）。
 * 这里把清单固化下来，并且**逐项打印通过/失败**，失败项直接给出脚本名便于重跑。
 *
 * 分类：
 *   [本地静态]  不需要网络，任何改动都能跑 —— 每次提交前至少跑这一类
 *   [在线]      需要访问 qtvq.cn / 需要密钥，用于部署后核验
 *
 * 用法：
 *   node tools/scripts/check-all.mjs          # 本地静态 + 在线（默认）
 *   node tools/scripts/check-all.mjs --local  # 只跑本地静态（离线可用）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const localOnly = process.argv.includes('--local');

/** 只跑本地静态检查（不需要网络/密钥） */
const LOCAL = [
  ['小程序接线（import/导出/模板变量/生命周期/页面入口）', 'tools/scripts/check-uni-wiring.mjs'],
  ['小程序静态（渠道一致/名单一致/图片存在）', 'tools/scripts/check-miniprogram.mjs'],
  ['全端平台矩阵（8 小程序 + H5 + App + 自动更新能力）', 'apps/qtvq-uni/scripts/check-platforms.js'],
  ['鸿蒙 uni-app x 工程（路由/uvue 样式限制/防漂移）', 'tools/scripts/check-uniappx.mjs'],
  ['下载页链路（生成文件/分区/容器/同源）', 'tools/scripts/check-download-page.mjs'],
  ['Pages Functions 打包预检（esbuild，与部署同规则）', 'tools/scripts/check-functions-bundle.mjs'],
  ['各端专用端口契约（纯函数单测 + 数据同源）', 'tools/scripts/check-app-bootstrap.mjs', ['--offline']],
  ['静态站死胡同（链接/锚点/按钮/导航）', 'tools/scripts/audit-dead-ends.mjs'],
  ['内容安全词表（绕过手法 + 误伤 + 复核级类别）', 'tools/scripts/check-content-safety.mjs'],
  ['文本水印（往返/截断可溯源/不误伤/不影响阅读）', 'tools/scripts/check-watermark.mjs'],
  ['设计令牌（packages/tokens 与两端产物是否漂移）', 'tools/scripts/gen-tokens.mjs', ['--check']],
  ['共享层纯度（L0–L3 禁平台 API）', 'tools/scripts/check-shared-purity.mjs'],
  ['ESM 导入导出交叉校验（单文件合法但组合即错）', 'tools/scripts/check-esm-exports.mjs'],
  ['HTML 内联脚本语法（无构建步骤会拦的那类错）', 'tools/scripts/check-inline-js.mjs'],
  ['三端派生自 shared（举报原因/收款渠道单一来源）', 'tools/scripts/check-shared-derivation.mjs'],
  ['图片格式守卫（picture 兜底/WebP 更小/无死文件）', 'tools/scripts/check-image-formats.mjs'],
  ['WebP 变体（存在/更小/像素一致）', 'tools/scripts/gen-image-webp.mjs', ['--check']],
  ['i18n 覆盖（t() 引用的键是否在 zh-CN 中有定义）', 'tools/scripts/check-i18n-coverage.mjs'],
  ['收款渠道声明（每个渠道必须显式声明是否自动到账）', 'tools/scripts/check-pay-channels.mjs'],
  ['二维码本地实现（jsQR 严格 + 宽松双模解码）', 'tools/scripts/check-qr-render.mjs'],
  ['PowerShell 脚本编码（UTF-8 BOM）', 'tools/scripts/check-ps1-bom.mjs'],
  ['增长内容矩阵（20 条 × 2 平台 + 40 渠道码 + 落地页接线）', 'tools/scripts/check-growth-content.mjs'],
  ['激活事件接线（两端上报点/埋点登录态/年龄门顺序）', 'tools/scripts/check-activation-wiring.mjs'],
  ['问答链路安全（内容审核/危机转介/号码单一来源/能力声明）', 'tools/scripts/check-safety-wiring.mjs'],
  ['小程序审核合规（iOS 虚拟支付/协议入口/隐私授权/境内模型）', 'tools/scripts/check-review-compliance.mjs'],
  ['埋点 SDK 运行时（报文契约/鉴权头/批量/失败回队）', 'tools/scripts/test-track-sdk.mjs'],
];

/** 需要网络或密钥 */
const ONLINE = [
  ['测试套件 43 项（接口/支付/账号/内容安全/静态页）', 'tools/scripts/test-suite.mjs'],
  ['各端专用端口（线上实测：渠道/更新结论/能力清单）', 'tools/scripts/check-app-bootstrap.mjs'],
  ['各端专用端口·双端闸门（Pages vs 自建 Node 逐字段）', 'tools/scripts/check-app-bootstrap-gate.mjs'],
  ['模型链路（Pages + Node 两侧真实探测）', 'tools/scripts/check-llm.mjs'],
  ['线上缓存策略（指纹长缓存 / 无指纹校验 / 不再清空缓存）', 'tools/scripts/check-cache-policy.mjs'],
  ['静态图片双端一致（源站 vs static.qtvq.cn，防旧收款码）', 'tools/scripts/check-static-domain-sync.mjs'],
  ['API 延迟预算（/v1/* P95 ≤ 800ms）', 'tools/scripts/check-api-perf.mjs'],
  ['服务端代码指纹（线上是否等于本地）', 'tools/scripts/server-build-sha.mjs', ['--check']],
];

const run = (label, script, extra = []) => {
  const full = path.join(ROOT, script);
  if (!fs.existsSync(full)) {
    console.log(`⏭️  ${label} —— 脚本不存在：${script}`);
    return { ok: null, label, script };
  }
  const t0 = Date.now();
  process.stdout.write(`▶️  ${label} ... `);
  const r = spawnSync('node', [full, ...extra], { cwd: ROOT, encoding: 'utf8' });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  console.log(`${ok ? '✅' : '❌'} ${(ms / 1000).toFixed(1)}s`);
  if (!ok) {
    // 失败时把子进程输出搬出来（截断，避免刷屏）
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n');
    const tail = out.slice(-12);
    for (const line of tail) console.log(`      ${line}`);
    if (out.length > tail.length) console.log(`      …（仅显示最后 ${tail.length} 行，完整输出请单独跑该脚本）`);
  }
  return { ok, label, script, ms };
};

const results = [];
console.log('══════ 本地静态检查 ══════');
for (const [label, script, extra] of LOCAL) results.push(run(label, script, extra));

if (!localOnly) {
  console.log('');
  console.log('══════ 在线检查（需要网络/密钥）══════');
  for (const [label, script, extra] of ONLINE) results.push(run(label, script, extra));
} else {
  console.log('');
  console.log('（--local：已跳过在线检查）');
}

const passed = results.filter((r) => r.ok === true).length;
const failed = results.filter((r) => r.ok === false);
const skipped = results.filter((r) => r.ok === null).length;

console.log('');
console.log('══════ 汇总 ══════');
console.log(`  通过 ${passed} · 失败 ${failed.length} · 跳过 ${skipped}`);
if (failed.length) {
  console.log('');
  console.log('  失败项（可直接单独重跑看完整输出）：');
  for (const f of failed) console.log(`    ❌ ${f.label}\n       node ${f.script}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
