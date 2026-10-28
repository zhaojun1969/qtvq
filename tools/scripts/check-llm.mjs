/**
 * 一条命令验证"模型换到通义了没有"。
 *
 * 覆盖两侧（本项目模型分散在两处，必须分别确认）：
 *   Pages 侧  /api/health?fresh=1  → llmChain（当前生效的链）+ aiProbe（真实探测到哪个 provider/model）
 *             /api/chat            → 真实问一句，看回复出自哪个 provider/model
 *   Node 侧   /v1/health           → models（provider/model/是否配置）+ llmChain（若已支持）
 *
 * 为什么要 fresh=1：/api/health 的 AI 探测结果缓存 5 分钟，不加这个参数会看到旧结果，
 * 于是"改完没生效"和"缓存没刷新"分不清 —— 这类误判本项目已经出现过多次。
 *
 * 用法: node tools/scripts/check-llm.mjs
 */
const BASE = process.env.QTVQ_API_BASE || 'https://qtvq.cn';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, opts) {
  const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' }, ...opts });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（网关错误页） */
  }
  return { status: res.status, json, text };
}

let problems = 0;
const bad = (m) => {
  console.log(`  ❌ ${m}`);
  problems += 1;
};
const good = (m) => console.log(`  ✅ ${m}`);

console.log('=== ① Pages 侧：当前生效的模型链 ===');
const health = await getJson(`${BASE}/api/health?fresh=1`);
if (!health.json) {
  bad(`/api/health 未返回 JSON（HTTP ${health.status}）`);
} else {
  const chain = health.json.llmChain || [];
  if (!chain.length) bad('llmChain 为空：模型链没解析出来');
  for (const c of chain) {
    console.log(`  ${c.configured ? '● 就绪' : '○ 未配置'}  ${c.provider}:${c.model}`);
  }
  const probe = health.json.aiProbe;
  if (probe?.ok) {
    good(`真实探测成功 → provider=${probe.provider} model=${probe.model}（第 ${probe.attempts} 条命中）样本「${probe.sample}」`);
    if (probe.provider !== 'tongyi') {
      console.log(`  ⚠️ 命中的不是通义。若期望通义，看下面的 aiErrors 是否 Free quota exhausted / InvalidApiKey`);
    }
  } else {
    bad(`真实探测失败：${JSON.stringify(health.json.aiErrors || []).slice(0, 300)}`);
  }
  if (health.json.llmReady === false) bad('llmReady=false：链里一条可用的都没有');
}

console.log('');
console.log('=== ② Pages 侧：真实问一句，看回复出自哪个模型 ===');
/*
 * 探针身份：固定 clientId 会**消耗该身份的免费额度**（每 clientId 24 小时 5 次）。
 * 2026-09-20 实际踩到：连跑几次把额度用光后，本脚本报
 * "❌ /api/chat 报错：24 小时内免费提问已达 5 次" —— 这是**探针自己造成的失败**，
 * 与模型无关，却会让 check:all 整体变红，久了就会被无视。
 * 所以：额度用尽判为「跳过」而不是「失败」；需要换身份时用 QTVQ_PROBE_CLIENT 指定。
 */
const probeClient = process.env.QTVQ_PROBE_CLIENT || 'llm_probe';
const chat = await getJson(`${BASE}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: '第一次约会要注意什么？一句话即可', clientId: probeClient }),
});
if (!chat.json) {
  bad(`/api/chat 未返回 JSON（HTTP ${chat.status}）：${String(chat.text).slice(0, 160)}`);
} else if (chat.json.code === 'QUOTA_EXCEEDED') {
  console.log(`  ⏭️  跳过：探针身份 ${probeClient} 的免费提问额度已用尽（与模型无关）。`);
  console.log('     模型到底能不能答，已由第 ① 步的 aiProbe（真实调用）证明；');
  console.log('     想再用这一项验证，换个身份即可：$env:QTVQ_PROBE_CLIENT="probe_<时间戳>"');
} else if (chat.json.error) {
  bad(`/api/chat 报错：${chat.json.error}`);
} else {
  const ai = chat.json.ai || {};
  console.log(`  回复（前 60 字）：${String(chat.json.reply || '').replace(/\s+/g, ' ').slice(0, 60)}`);
  if (chat.json.fallback) {
    bad(`走了兜底文案（fallbackReason=${chat.json.fallbackReason}）：${(ai.errors || []).join(' | ').slice(0, 200)}`);
  } else {
    good(`由 ${ai.provider}:${ai.model} 回答（第 ${ai.attempts} 条命中）`);
  }
  if (ai.errors?.length) console.log(`  链上前面的失败：${ai.errors.join(' | ').slice(0, 240)}`);
}

console.log('');
console.log('=== ③ Node 侧（配对报告）===');
const v1 = await getJson(`${BASE}/v1/health`);
const d = v1.json?.data || v1.json;
if (!d) {
  bad(`/v1/health 未返回 JSON（HTTP ${v1.status}）`);
} else {
  const m = d.models || {};
  console.log(`  LLM : provider=${m.llm?.provider} model=${m.llm?.model} configured=${m.llm?.configured}${m.llm?.source ? ` (${m.llm.source})` : ''}`);
  console.log(`  向量 : provider=${m.embed?.provider} model=${m.embed?.model} configured=${m.embed?.configured}`);
  if (m.llmProviderEnv) console.log(`  旧配置 LLM_PROVIDER=${m.llmProviderEnv}（设了 LLM_CHAIN 后它不再决定用谁）`);

  /*
   * 注意：链在 `models.llmChain` 里（**不在顶层**）。
   * 第一版这里读的是 `d.llmChain`，于是明明服务端已经输出了链，脚本却打印
   * "服务端尚未输出 llmChain —— 该版本还没部署"，并据此给出"报告侧未切到通义"的**假结论**。
   * 又一次"诊断工具把自己的取值路径写错，当成对方的缺陷"。现在两个位置都读，并优先用 models 里的。
   */
  const chain = (Array.isArray(m.llmChain) && m.llmChain.length ? m.llmChain : d.llmChain) || [];
  if (chain.length) {
    console.log('  链  :');
    for (const c of chain) console.log(`    ${c.configured ? '● 就绪' : '○ 未配置'}  ${c.provider}:${c.model}`);
  } else {
    console.log('  链  : （服务端未输出 llmChain —— 该版本还没部署）');
  }

  const primary = chain.find((c) => c.configured);
  if (primary && (primary.provider === 'tongyi' || primary.provider === 'dashscope')) {
    good(`报告侧已切到通义（${primary.model}）`);
  } else if (chain.length) {
    console.log(`  ℹ️ 报告侧首选仍是 ${primary ? primary.provider : '(无可用条目)'} —— 想让通义当首选，在服务器 .env 设 LLM_CHAIN 并重启`);
  }

  // 有管理员密钥时顺手做一次真实探测（比"链里写了什么"更硬：它证明模型真的答了）
  const adminKey = process.env.QTVQ_ADMIN_KEY || '';
  if (adminKey) {
    const probe = await getJson(`${BASE}/v1/health?probe=llm`, { headers: { 'X-Admin-Key': adminKey } });
    const p = (probe.json?.data || probe.json)?.llmProbe;
    if (p?.ok) good(`真实探测成功 → provider=${p.provider} model=${p.model}（第 ${p.attempts} 条命中，${p.ms}ms）样本「${p.sample}」`);
    else bad(`真实探测失败：${p?.error || JSON.stringify(p)}`);
  } else {
    console.log('  ℹ️ 未设 QTVQ_ADMIN_KEY，跳过 /v1/health?probe=llm 真实探测（只看了配置，没证明模型真的答得出来）');
  }
}

console.log('');
console.log(problems === 0 ? '✅ 两侧模型配置检查通过' : `❌ 发现 ${problems} 处问题`);
await sleep(0);
process.exit(problems ? 1 : 0);
