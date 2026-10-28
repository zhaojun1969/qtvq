/**
 * `/api/chat`（及 `/v1/chat`）—— 智慧问答 + 避坑检索（**境内 Node 版**）
 *
 * 2026-10-26 从 `functions/api/chat.js` 迁来。迁移动机是延迟：
 * 那个版本跑在 Cloudflare Pages Functions 上，客户端每问一次都要跨境，
 * 实测 P50 641ms / P95 6.7s（最坏 30.6s）；本机 `/v1/*` 是 P95 16ms。
 *
 * ── 契约必须与 Pages 版逐字段一致 ─────────────────────────────────────────
 * 前端（`js/chat.js` 等）没有改，所以响应字段（reply / qCoins / wisdom /
 * followUpHint / quota / rag / ai / fallback / fallbackReason / aiError）
 * 与错误码（`QUOTA_EXCEEDED` 403、参数错误 400、限流 429）都照原样保留。
 *
 * ── RAG 没有被降级（原判断有误，已实测更正）─────────────────────────────
 * 我最初以为 Node 侧只有关键词检索，实际不是：`services/pitfalls.js` 的
 * `retrievePitfalls()` 会先调 `embedOne()` 取查询向量，再与 Mongo 里存的
 * `vector` 字段做余弦相似度（`method: 'vector'`），取不到向量才退回关键词打分。
 * 2026-10-26 实测响应即为 `rag.method: "vector"`，**召回质量与 Pages 版一致**。
 * 差异只在向量来源：Pages 用 Cloudflare Vectorize，Node 用 Mongo 自存向量 + 境内 embedding。
 *
 * ── 另一处有意为之的差异 ──────────────────────────────────────────────────
 * 限流：Pages 版是模块级 Map（实例重启即清空），这里同样用进程内内存，
 * 但窗口与阈值保持一致（60s 内 20 次）。单进程部署下语义等价。
 */

import { Router } from 'express';
import { chat } from '../services/llm.js';
import { retrievePitfalls, formatPitfalls, publicHits } from '../services/pitfalls.js';
import { canAsk, recordAsk, getQuota } from '../services/quota-store.js';
import {
  quickCheck,
  crisisCheck,
  buildSupportCard as buildSupport,
  distressCheck,
  buildGentleTip,
} from '../services/content-safety.js';

const router = Router();

const SYSTEM_PROMPT = `你是「我心永恒-Q问」的情感智慧顾问。你的风格是「避坑+直线解决」：
- 不说鸡汤，不给模糊安慰
- 用3步以内给出可执行的行动方案
- 指出常见陷阱与代价
- 保护隐私，不索要真实姓名/联系方式
- 回答简洁有力，中文回复
- 若提供了【检索到的相关避坑案例】，必须优先参考案例中的直线方案，可点名相关陷阱`;

const KNOWLEDGE_FALLBACK = `
避坑知识库摘要（兜底）：
- 网恋：未见面不转账、不投资、要视频验证、防杀猪盘
- 暧昧：3个月期限、直接确认关系、防备胎与养鱼
- 冷暴力：发底线沟通、到期止损、不反复道歉
- 彩礼见家长：书面约定、礼物适度、观察双向尊重
- 出轨：明确边界、原谅需行动、二次出轨离开
`;

const MOCK_REPLIES = [
  '先把问题拆成三件事：你想要什么、对方给了什么、代价你能不能接受。写下来再看，情绪会说话但事实不会。',
  '别再猜对方心思——直接问一个具体问题，设一个期限。含糊的答案本身就是答案。',
  '给自己一条底线：什么行为出现你就退出。写下来、告诉一个朋友，比反复纠结有效。',
];

function buildSystemPrompt(message, ragContext) {
  let extra = '';
  if (/借钱|转账|投资/.test(message)) extra = '重点：网恋金钱陷阱，绝不转账。';
  else if (/暧昧|备胎/.test(message)) extra = '重点：暧昧期限与确认关系。';
  else if (/冷暴力|已读不回/.test(message)) extra = '重点：底线沟通与止损。';
  else if (/彩礼|见家长|结婚/.test(message)) extra = '重点：婚恋家庭边界与书面约定。';
  else if (/出轨/.test(message)) extra = '重点：边界与行动，非口头道歉。';

  const knowledge = ragContext
    ? `\n\n【检索到的相关避坑案例】\n${ragContext}\n\n请结合以上真实案例回答，必要时引用案例标题。`
    : KNOWLEDGE_FALLBACK;

  return SYSTEM_PROMPT + knowledge + (extra ? '\n' + extra : '');
}

/** 按 IP 的分钟级限流（与原实现同阈值：60s / 20 次） */
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

/*
 * 危机卡片的文案与号码**不在这里** —— 现在是 `packages/safety/src/crisis.js`
 * 的 `buildSupportCard`，与 Pages 侧共用同一份。
 *
 * 为什么下沉：这段话会同时出现在官网、小程序、以及 Pages 回退路径上。
 * 各写一份的必然结果是漂移（改一处漏两处），而这里的字段是电话号码 ——
 * 写错等于把人引到空号。上一版就在本文件里手写过一份，趁接 Pages 侧时收掉了。
 */

router.post('/', async (req, res) => {
  const ip = req.headers['cf-connecting-ip'] || req.ip || 'local';
  if (!checkRate(ip)) {
    return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  }

  const body = req.body || {};
  const { message, followUp, clientId } = body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: '请输入您的问题' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: '问题过长，请精简后重试' });
  }

  const cid =
    clientId && typeof clientId === 'string' ? clientId.slice(0, 64) : `ip:${ip}`.slice(0, 64);

  try {
    /*
     * 内容审核放在**配额检查之前**：被判为不通过的内容不该消耗用户的免费次数。
     * 这里只跑本地词表（微秒级），不调远端 —— 详见 content-safety.quickCheck 的注释。
     *
     * 2026-10-28 补：此前 `/v1/chat` 是**唯一一个没有任何审核**的生成入口。
     * 资料、报告题目、报告输出都走了 assertSafe，唯独每问必走的问答链路没有。
     */
    const safety = await quickCheck(message.trim(), { field: 'chat_question', clientId: cid });
    if (safety.action === 'block') {
      return res.status(400).json({
        error: '这段内容无法处理，请换个说法',
        code: 'E_CONTENT_BLOCKED',
      });
    }

    /*
     * 危机识别：`level: 'urgent'` 时在响应里附 `support`（求助资源），前端渲染成卡片。
     * 刻意**不**拒绝这次提问、**不**改写 AI 回答 —— 一个人说「我不想活了」的时候，
     * 最不该做的就是让系统表现得像被冒犯了。正常回答照给，只是多一张卡片。
     */
    const crisis = crisisCheck(message.trim());
    const supportCard = buildSupport(crisis);
    /*
     * 第二档：痛苦表述 → 一条窄提示（不是卡片）。
     * 明确级已经出卡片时**不再叠**这条：两张东西一起出现会让页面变成警报页，
     * 而这一档的全部意义就是"轻"。判定逻辑与取舍见 packages/safety/src/distress.js。
     */
    const gentleTip = supportCard ? null : buildGentleTip(distressCheck(message.trim()));

    const quotaCheck = await canAsk(cid, !!followUp);
    if (!quotaCheck.ok) {
      if (quotaCheck.code === 'QUOTA_EXCEEDED') {
        return res.status(403).json({
          error: '24 小时内免费提问已达 5 次，请办理月卡/季卡/年卡，汇款核实后解禁不限次数提问',
          code: 'QUOTA_EXCEEDED',
          quota: quotaCheck.quota,
        });
      }
      return res.status(400).json({ error: quotaCheck.error || '无法提问' });
    }

    const userContent = followUp ? `用户追问（需要更具体的行动步骤）：${message.trim()}` : message.trim();

    const rag = await retrievePitfalls(message.trim(), 3);
    const ragContext = rag.hits?.length ? formatPitfalls(rag.hits) : null;
    const systemContent = buildSystemPrompt(message, ragContext);

    const ai = await chat({
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent },
      ],
      temperature: 0.8,
      maxTokens: 1200,
    });

    let reply = ai.text;
    let fallback = false;
    let fallbackReason = null;
    if (!reply) {
      reply = MOCK_REPLIES[Math.floor(Math.random() * MOCK_REPLIES.length)];
      fallback = true;
      fallbackReason = ai.error ? 'ALL_MODELS_FAILED' : 'NO_MODEL_CONFIGURED';
    }

    if (!followUp) await recordAsk(cid);

    const quota = await getQuota(cid, { withBilling: false });
    return res.json({
      reply,
      qCoins: fallback ? 5 : 10,
      wisdom: fallback ? 1 : Math.min(5, Math.floor(message.length / 50) + 1),
      followUpHint: '点击「再问一步」获取更具体的行动措辞',
      quota,
      rag: {
        // 诚实标注检索方式：这里没有向量检索，方法名就是 keyword/none
        ready: rag.hits?.length > 0,
        method: rag.method,
        hits: publicHits(rag.hits || []),
      },
      ai: {
        provider: ai.provider || null,
        model: ai.model || null,
        attempts: ai.attempts || (ai.error ? 1 : 0),
        viaReasoning: false,
        errors: ai.error ? [ai.error] : [],
      },
      ...(fallback ? { fallback: true, fallbackReason, aiError: ai.error || null } : {}),
      ...(supportCard ? { support: supportCard } : {}),
      ...(gentleTip ? { gentle: gentleTip } : {}),
    });
  } catch (err) {
    console.error('[chat] 生成失败：', err?.message || err);
    /*
     * 生成失败时也带危机资源：求助资源的存在与否**不该取决于模型是否可用**。
     * 这正是「AI 挂了」最不该连带的损失 —— 一个人来求助，模型超时了，
     * 卡片也没有了，那这条链路在关键时刻是空的。
     */
    const supportOnError = buildSupport(crisisCheck(message.trim()));
    return res.json({
      reply: MOCK_REPLIES[0],
      qCoins: 5,
      wisdom: 1,
      fallback: true,
      fallbackReason: 'EXCEPTION',
      aiError: err?.message || String(err),
      ...(supportOnError ? { support: supportOnError } : {}),
    });
  }
});

export default router;
