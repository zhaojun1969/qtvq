/**
 * 模型可用性诊断：逐个试当前密钥下每个模型，报出可用/不可用与真实原因。
 *
 * 用法：node scripts/probe-models.mjs
 *
 * 为什么需要它：百炼在「仅使用免费额度」模式下，额度用尽会返回
 * 403 AllocationQuota.FreeTierOnly；不同模型的免费额度是分别计算的，
 * 所以「qwen-plus 不可用」不等于「全都不可用」。跑一遍就知道该把
 * CHAT_MODEL 配成什么。
 */
import { env, providerStatus } from '../src/config/env.js';
import { chat } from '../src/services/llm.js';
import { embedOne, isEmbedConfigured } from '../src/services/embed.js';

const PROBE_MESSAGES = [
  { role: 'system', content: '你是测试助手，只回复一个词。' },
  { role: 'user', content: '回复：连通' },
];

function line(ok, label, detail) {
  const mark = ok === null ? '·' : ok ? '\u2713' : '\u2717';
  console.log(`  ${mark} ${label}${detail ? `  — ${detail}` : ''}`);
}

async function main() {
  const status = providerStatus();
  console.log('== 模型可用性诊断 ==');
  console.log(`  Provider: ${status.embed.provider} / ${status.llm.provider}`);
  console.log(`  维度配置: ${status.embedDims}\n`);

  // ---- Embedding ----
  console.log('[Embedding]');
  if (!isEmbedConfigured()) {
    line(false, `${status.embed.model}`, '未配置密钥，跳过');
  } else {
    const t0 = Date.now();
    const v = await embedOne('测试文本：网恋借钱要转账');
    if (v) {
      line(true, status.embed.model, `${v.length} 维，${Date.now() - t0}ms`);
      if (v.length !== status.embedDims) {
        line(null, '注意', `实际维度 ${v.length} ≠ 配置的 EMBED_DIMS=${status.embedDims}，向量索引/比较会失真`);
      }
    } else {
      line(false, status.embed.model, `${Date.now() - t0}ms，调用失败（详见上方日志）`);
    }
  }

  // ---- Chat 降级链 ----
  const provider = env.llmProvider;
  const container = provider === 'dashscope' ? env.dashscope : provider === 'workers-ai' ? env.cf : null;
  const chain =
    provider === 'dashscope'
      ? env.dashscope.chatModels
      : provider === 'workers-ai'
        ? env.cf.chatModels
        : [env.openai.chatModel];
  const original = container ? container.chatModels : null;

  console.log('\n[Chat] 逐个测试（顺序即降级链顺序）');
  const usable = [];
  for (const model of chain) {
    // 临时把链缩成单个模型，就能拿到「这个模型本身」的成败，而不是整条链的结果
    if (container) container.chatModels = [model];
    const t0 = Date.now();
    const r = await chat({ messages: PROBE_MESSAGES, maxTokens: 128, temperature: 0.1 });
    const ms = Date.now() - t0;
    if (r.text) {
      line(true, model, `${ms}ms，返回「${r.text.replace(/\s+/g, ' ').slice(0, 20)}」`);
      usable.push(model);
    } else {
      line(false, model, `${ms}ms，${r.error || '未知错误'}`);
    }
  }
  if (container) container.chatModels = original;

  // ---- 结论 ----
  console.log('\n' + '='.repeat(64));
  if (usable.length) {
    console.log(`可用模型：${usable.join(', ')}`);
    console.log(`建议把 .env 的 CHAT_MODEL 配成：`);
    console.log(`  CHAT_MODEL=${[...new Set([...usable, ...chain])].join(',')}`);
  } else {
    console.log('没有任何对话模型可用。');
    console.log('若错误是 403 AllocationQuota.FreeTierOnly，两种处理：');
    console.log('  a) 阿里云百炼控制台 → 关闭「仅使用免费额度」模式（转为按量付费）');
    console.log('  b) 为账号充值后重试');
    console.log('在修好之前服务不会报错，只是报告走确定性兜底文案。');
  }
  console.log('='.repeat(64));
  process.exit(usable.length || !chain.length ? 0 : 1);
}

main().catch((err) => {
  console.error('诊断异常:', err);
  process.exit(1);
});
