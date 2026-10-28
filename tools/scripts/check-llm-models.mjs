/**
 * 探测通义/百炼（DashScope）当前**哪些模型真的能用**。
 *
 * 为什么要这个：模型名、可用额度、是否已开通按量付费，这三件事在各家控制台里
 * 都写得含糊，而"配置看起来正确但一调就 403"是本项目反复踩的坑。
 * 这个脚本直接用真实 key 打一次最小请求（max_tokens 很小），把每一档的真实结果打出来：
 *   ✅ 可用 / ⛔ 配额（AllocationQuota.*） / ❓ 模型名不存在（ModelNotFound） / ⚠️ 其它错误
 *
 * key 的读取顺序（都只从本地文件读，绝不打印）：
 *   1) 环境变量 DASHSCOPE_API_KEY
 *   2) server/.env        的 DASHSCOPE_API_KEY
 *   3) .dev.vars          的 DASHSCOPE_API_KEY
 *
 * 用法：
 *   node tools/scripts/check-llm-models.mjs                 # 默认候选列表
 *   node tools/scripts/check-llm-models.mjs qwen-long qwen-plus-character
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.DASHSCOPE_BASE || 'https://dashscope.aliyuncs.com/compatible-mode/v1';

function readKey() {
  if (process.env.DASHSCOPE_API_KEY) return { key: process.env.DASHSCOPE_API_KEY, from: '环境变量' };
  for (const file of ['server/.env', '.dev.vars']) {
    if (!fs.existsSync(file)) continue;
    const line = fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .find((l) => /^\s*DASHSCOPE_API_KEY\s*=/.test(l));
    if (!line) continue;
    const value = line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
    if (value) return { key: value, from: file };
  }
  return { key: '', from: null };
}

const { key, from } = readKey();
if (!key) {
  console.log('❌ 没有找到 DASHSCOPE_API_KEY（环境变量 / server/.env / .dev.vars 都没有）');
  process.exit(2);
}
console.log(`Key 来源: ${from}（长度 ${key.length}，不打印内容）`);
console.log(`端点    : ${BASE}/chat/completions`);
console.log('');

const DEFAULT_MODELS = [
  'qwen-turbo',
  'qwen-plus',
  'qwen-max',
  'qwen-flash',
  'qwen-long',
  'qwen3-max',
  // 角色扮演（Qwen-Character）：百炼里"通义角色"的等价能力，人设写在 system/messages 里
  'qwen-plus-character',
  'qwen-max-character',
  'qwen-character',
];
const models = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_MODELS;

async function probe(model) {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '只回复两个字：可用' }],
        max_tokens: 16,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      /* 非 JSON 响应（网关错误页等） */
    }
    const ms = Date.now() - started;
    if (res.ok) {
      const reply = data?.choices?.[0]?.message?.content ?? '';
      return { ok: true, ms, detail: `回复「${String(reply).trim().slice(0, 12)}」` };
    }
    const code = data?.error?.code || data?.code || `HTTP_${res.status}`;
    const msg = String(data?.error?.message || data?.message || text).slice(0, 140);
    return { ok: false, ms, code, detail: msg };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, code: 'NETWORK', detail: err?.message || String(err) };
  }
}

console.log('模型'.padEnd(24) + '结果');
console.log('-'.repeat(96));
const usable = [];
for (const model of models) {
  const r = await probe(model);
  const flag = r.ok
    ? '✅ 可用'
    : r.code === 'NETWORK'
      ? '⚠️ 网络/超时'
      : String(r.code).includes('AllocationQuota')
        ? '⛔ 配额受限'
        : /ModelNotFound|model_not_found|InvalidParameter/i.test(String(r.code))
          ? '❓ 模型名不存在'
          : '⚠️ 调用失败';
  if (r.ok) usable.push(model);
  console.log(`${model.padEnd(24)}${flag.padEnd(14)}${String(r.ms).padStart(6)}ms  ${r.detail}`);
}

console.log('');
if (usable.length) {
  console.log(`✅ 当前可用模型（${usable.length}）: ${usable.join(', ')}`);
} else {
  console.log('❌ 候选里没有一个可用。常见原因见下：');
  console.log('   · AllocationQuota.FreeTierOnly → 百炼"仅使用免费额度"仍开着或额度用尽：');
  console.log('     控制台 → 模型工作室/百炼 → 费用与配额 → 关闭"仅免费额度"或充值（支付宝）。');
  console.log('   · InvalidApiKey / App.AccessDenied → key 与实际要用的应用不属于同一账号。');
}
process.exit(usable.length ? 0 : 1);
