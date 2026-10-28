#!/usr/bin/env node
/**
 * API 延迟预算校验（在线，客户端视角）
 *
 * C2 的性能预算：`/v1/*` P95 ≤ 800ms。
 *
 * 实测基线（2026-10-26，源站本机直连 Node，30 次采样）：
 *   /v1/health           P50 3.0ms  P95  4.1ms
 *   /v1/pitfalls         P50 1.1ms  P95  3.5ms
 *   /v1/app/bootstrap    P50 1.1ms  P95  1.3ms
 *   /v1/safety/status    P50 1.2ms  P95  1.6ms
 *   带身份：/v1/wallet       P50 2.7ms  P95  3.6ms
 *           /v1/report/mine  P50 2.5ms  P95  4.0ms
 *           /v1/admin/overview P50 10.2ms P95 15.6ms  ← 全站最慢
 * 即：**全部端点都在预算的 1/50 以内**。
 *
 * 这个检查器的意义不是"现在能过"，而是**将来退化时能被发现**——
 * 例如有人加了一个没建索引的查询，P95 从 3ms 变成 900ms。
 *
 * 刻意排除的端点（不纳入 800ms 断言）：
 *   · `POST /v1/report/generate`、`/v1/report/invite/:token/accept`
 *     —— 会同步调用大模型（`server/src/services/llm.js` 超时 45s），
 *        耗时由上游决定，不是本服务的代码问题。它需要的是架构改造
 *        （异步任务 + 轮询，或流式），不是"优化查询"。
 *   · `POST /v1/safety/image` —— 调阿里云内容安全（超时 8s）。
 *
 * 需要联网，属于 check-all 的在线检查部分。
 */
const BASE = process.env.QTVQ_BASE || 'https://qtvq.cn';

/** 要求 P95 ≤ 800ms 的端点（无鉴权、可安全重复调用） */
const FAST_ENDPOINTS = ['/v1/health', '/v1/pitfalls', '/v1/app/bootstrap', '/v1/safety/status', '/api/quota?clientId=perf-check'];// /api/quota 已于 2026-10-26 迁到本机 Node，与 /v1/* 同量级
const FAST_BUDGET_MS = 800;

/**
 * 跨机构路径：`/api/*` 由 Cloudflare Pages Functions 提供，一次调用要跨到境外再回来
 * （实测 0.8–1.8s）。它不受 800ms 预算约束，但必须有上限，否则会悄悄恶化成 10s。
 */
const CROSS_BORDER = [{ path: '/api/health', budgetMs: 3000 }];

const SAMPLES = 10;
const GAP_MS = 120; // 避开 nginx 的 limit_req（10/3/1 r/s）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sample(path) {
  const times = [];
  let status = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = performance.now();
    try {
      const res = await fetch(BASE + path, {
        headers: { 'User-Agent': 'qtvq-check-api-perf/1.0' },
        redirect: 'manual',
      });
      status = res.status;
      await res.arrayBuffer();
    } catch {
      status = 0;
    }
    times.push(performance.now() - t0);
    if (i < SAMPLES - 1) await sleep(GAP_MS);
  }
  times.sort((a, b) => a - b);
  const pick = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))];
  return { status, p50: pick(0.5), p95: pick(0.95), max: times[times.length - 1] };
}

function fmt(ms) {
  return `${ms.toFixed(0)}ms`;
}

const problems = [];
const warnings = [];
const crossRows = [];
const rows = [];

for (const path of FAST_ENDPOINTS) {
  const r = await sample(path);
  rows.push([path, r.status, r.p50, r.p95, FAST_BUDGET_MS]);
  if (r.status !== 200) problems.push(`${path} 状态码 ${r.status}（应为 200）`);
  else if (r.p95 > FAST_BUDGET_MS) {
    problems.push(`${path} P95=${fmt(r.p95)} 超过 ${FAST_BUDGET_MS}ms 预算（P50=${fmt(r.p50)}）`);
  }
}

/**
 * 跨境路径：**只告警，不判红**。
 *
 * 原因（2026-10-26 实测）：`/api/*` 由 Cloudflare Pages Functions 提供，
 * 三条路（经 ECS 中继 / 直连 api.qtvq.cn / 直连 pages.dev）全部跨境，
 * 客户端 P50 0.6–0.9s、P95 3–7s，最坏一次 30.6s。这是**结构问题，不是本仓库的 bug**，
 * 修法是迁移（见 docs 附录 E.30），不是调参数。
 *
 * 如果把它设成硬失败，套件会长期飘红 —— 红久了就没人看了，反而不如明确标注"已知问题"。
 * 等迁移完成后，把它升级回硬断言即可（把 warnOnly 去掉）。
 */
for (const { path, budgetMs } of CROSS_BORDER) {
  const r = await sample(path);
  if (r.status !== 200) {
    problems.push(`${path} 状态码 ${r.status}（应为 200）`);
    continue;
  }
  const over = r.p95 > budgetMs;
  warnings.push(
    `${path} P95=${fmt(r.p95)} P50=${fmt(r.p50)}（参考上限 ${budgetMs}ms）` +
      (over ? ' ← 已知：跨境链路不稳定，见附录 E.30' : ''),
  );
  crossRows.push([path, r.status, r.p50, r.p95, budgetMs]);
}

for (const [p, st, p50, p95, budget] of rows) {
  const ok = st === 200 && p95 <= budget;
  console.log(
    `  ${ok ? '✓' : '✗'} ${p.padEnd(22)} ${String(st).padStart(3)}  P50 ${fmt(p50).padStart(6)}  P95 ${fmt(p95).padStart(6)}  (预算 ${budget}ms)`,
  );
}

if (problems.length) {
  console.error(`[check-api-perf] ❌ ${problems.length} 处不达标：`);
  for (const p of problems) console.error('  ' + p);
  console.error(
    '\n提示：若 `/v1/*` 突然变慢，先看 Mongo 是否缺索引（qtvq-api-latency 可看线上真实分位），' +
      '再看是否新增了同步外部调用。',
  );
  process.exit(1);
}

console.log(`[check-api-perf] ✅ ${rows.length} 个 /v1 端点 P95 均在预算内（≤ 800ms）`);
for (const [p, st, p50, p95, budget] of crossRows) {
  console.log(
    `  ℹ ${p.padEnd(22)} ${String(st).padStart(3)}  P50 ${fmt(p50).padStart(6)}  P95 ${fmt(p95).padStart(6)}  (跨境，参考 ${budget}ms)`,
  );
}
for (const w of warnings) console.log(`  ⚠ ${w}`);
