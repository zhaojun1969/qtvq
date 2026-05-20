/**
 * Cloudflare Pages Function — Q智慧问答
 * 部署后绑定 Workers AI，模型推荐 @cf/meta/llama-3-8b-instruct
 */

import { canAsk, recordAsk, getQuota } from '../lib/quota-store.js';
const SYSTEM_PROMPT = `你是「我心永恒-Q问」的情感智慧顾问。你的风格是「避坑+直线解决」：
- 不说鸡汤，不给模糊安慰
- 用3步以内给出可执行的行动方案
- 指出常见陷阱与代价
- 保护隐私，不索要真实姓名/联系方式
- 回答简洁有力，中文回复`;

const KNOWLEDGE = `
避坑知识库摘要：
- 网恋：未见面不转账、不投资、要视频验证、防杀猪盘
- 暧昧：3个月期限、直接确认关系、防备胎与养鱼
- 冷暴力：发底线沟通、到期止损、不反复道歉
- 彩礼见家长：书面约定、礼物适度、观察双向尊重
- 出轨：明确边界、原谅需行动、二次出轨离开
`;

function buildSystemPrompt(message) {
  let extra = '';
  if (/借钱|转账|投资/.test(message)) extra = '重点：网恋金钱陷阱，绝不转账。';
  else if (/暧昧|备胎/.test(message)) extra = '重点：暧昧期限与确认关系。';
  else if (/冷暴力|已读不回/.test(message)) extra = '重点：底线沟通与止损。';
  else if (/彩礼|见家长|结婚/.test(message)) extra = '重点：婚恋家庭边界与书面约定。';
  else if (/出轨/.test(message)) extra = '重点：边界与行动，非口头道歉。';
  return SYSTEM_PROMPT + KNOWLEDGE + (extra ? '\n' + extra : '');
}

const MOCK_REPLIES = [
  '【直线方案】\n1. 今晚先不发长文，发一句具体关心（如「记得吃饭」），观察对方是否回应。\n2. 若24小时无回应，不要追问，隔天用轻松话题试探。\n3. 避坑：连续发小作文会被视为压迫感。\n\n【再问一步】需要我帮你写第一条消息的具体措辞吗？',
  '【直线方案】\n1. 明确你的底线：借钱/投资类请求，未见面一律拒绝。\n2. 回复模板：「我们还不够熟，这类事我不方便。」\n3. 避坑：转账备注写「借款」可能被追债，绝不转账。\n\n【代价】金钱+信任，平均损失数千至数万。',
  '【直线方案】\n1. 冷暴力超过3天，发一条「我需要沟通，X日前谈或各自冷静」。\n2. 到期无回应，停止投入，把精力转回自己。\n3. 避坑：反复道歉换不来尊重，只会降低你的议价权。',
];

export async function onRequestPost(context) {
  const { request, env } = context;

  // 简易速率限制（生产环境建议用 KV）
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  if (!checkRate(ip)) {
    return json({ error: '请求过于频繁，请稍后再试' }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '无效的请求格式' }, 400);
  }

  const { message, followUp, clientId } = body;
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return json({ error: '请输入您的问题' }, 400);
  }
  if (message.length > 2000) {
    return json({ error: '问题过长，请精简后重试' }, 400);
  }

  const cid =
    clientId && typeof clientId === 'string'
      ? clientId.slice(0, 64)
      : `ip:${ip}`.slice(0, 64);
  const quotaCheck = await canAsk(env, cid, !!followUp);
  if (!quotaCheck.ok) {
    if (quotaCheck.code === 'QUOTA_EXCEEDED') {
      return json(
        {
          error: '24 小时内免费提问已达 5 次，请办理月卡/季卡/年卡，汇款核实后解禁不限次数提问',
          code: 'QUOTA_EXCEEDED',
          quota: quotaCheck.quota,
        },
        403
      );
    }
    return json({ error: quotaCheck.error || '无法提问' }, 400);
  }

  const userContent = followUp
    ? `用户追问（需要更具体的行动步骤）：${message.trim()}`
    : message.trim();

  try {
    let reply;

    if (env.AI) {
      const response = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
        messages: [
          { role: 'system', content: buildSystemPrompt(message) },
          { role: 'user', content: userContent },
        ],
        max_tokens: 512,
      });
      reply =
        response?.response ||
        response?.result?.response ||
        (typeof response === 'string' ? response : null);
    }

    if (!reply) {
      reply = MOCK_REPLIES[Math.floor(Math.random() * MOCK_REPLIES.length)];
    }

    if (!followUp) await recordAsk(env, cid);

    return json({
      reply,
      qCoins: 10,
      wisdom: Math.min(5, Math.floor(message.length / 50) + 1),
      followUpHint: '点击「再问一步」获取更具体的行动措辞',
      quota: await getQuota(env, cid),
    });
  } catch (err) {
    console.error('AI error:', err);
    return json({
      reply: MOCK_REPLIES[0],
      qCoins: 5,
      wisdom: 1,
      fallback: true,
    });
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

const rateMap = new Map();
function checkRate(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip) || { count: 0, reset: now + 60000 };
  if (now > entry.reset) {
    rateMap.set(ip, { count: 1, reset: now + 60000 });
    return true;
  }
  if (entry.count >= 20) return false;
  entry.count++;
  rateMap.set(ip, entry);
  return true;
}
