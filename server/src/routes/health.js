/** 健康检查：不泄漏密钥，只报「是否配置」 */
import { Router } from 'express';
import { providerStatus, env } from '../config/env.js';
import { getDB } from '../config/db.js';
import { buildInfo } from '../lib/build-info.js';
import { chat } from '../services/llm.js';
import { getWechatPayConfig, isWechatPayConfigured } from '../services/wechat-pay.js';
import { ok, wrap } from '../lib/http.js';

const router = Router();

router.get(
  '/',
  wrap(async (req, res) => {
    let mongo = { connected: false };
    let hint = null;
    try {
      const db = getDB();
      await db.command({ ping: 1 });
      const [users, pitfalls, reports, wallets] = await Promise.all([
        db.collection('users').estimatedDocumentCount(),
        db.collection('pitfalls').estimatedDocumentCount(),
        db.collection('reports').estimatedDocumentCount(),
        db.collection('wallet').estimatedDocumentCount(),
      ]);
      mongo = { connected: true, db: db.databaseName, users, pitfalls, reports, wallets };
    } catch (err) {
      mongo = { connected: false, error: err.message };
      // 服务改成「先监听、再带重试连库」了：Mongo 挂了这里会如实报出来，
      // 而不是整个端口没响应（那样最容易被误判成代码坏了）
      hint =
        'MongoDB 不可用。检查顺序：1) systemctl is-active mongod  2) .env 里的 MONGO_URI  3) 27017 是否放通。' +
        '本服务每 2–30 秒自动重连，数据库恢复后无需重启服务。';
    }

    /*
     * ?probe=llm —— 真跑一次模型链，报出"哪个 provider/model 答的"。
     *
     * 为什么需要：换模型之后"到底生效没生效"必须有**可远程观察的证据**，
     * 而不是靠"我改了 .env 并重启了"（本项目在部署验证上吃过太多次亏，见 §9.24/§9.30）。
     * 探测会产生一次极小的模型调用（几十 token），因此**要求管理员密钥**，避免被刷。
     *
     * 用法：curl -H "X-Admin-Key: <ADMIN_KEY>" "https://qtvq.cn/v1/health?probe=llm"
     */
    let llmProbe = null;
    if (String(req.query.probe || '') === 'llm') {
      const provided = req.header('X-Admin-Key') || '';
      if (!env.adminKey) {
        llmProbe = { ok: false, error: '服务端未配置 ADMIN_KEY，探测已禁用' };
      } else if (provided !== env.adminKey) {
        llmProbe = { ok: false, error: '需要 X-Admin-Key' };
      } else {
        const t0 = Date.now();
        const r = await chat({
          messages: [{ role: 'user', content: '回复两个字：可用' }],
          maxTokens: 64,
          temperature: 0.2,
        });
        llmProbe = {
          ok: !!r.text,
          provider: r.provider,
          model: r.model,
          attempts: r.attempts || 0,
          ms: Date.now() - t0,
          sample: r.text ? String(r.text).slice(0, 40) : null,
          error: r.text ? null : r.error,
        };
      }
    }

    return ok(res, {
      service: 'qtvq-server',
      route: 'B-配对报告',
      // 代码指纹：改完部署后与本地 tools/scripts/server-build-sha.mjs 比对，
      // 一致即证明"线上跑的就是这份代码"，不用开 SSH 看文件。
      build: buildInfo,
      time: new Date().toISOString(),
      mongo,
      ...(hint ? { hint } : {}),
      ...(llmProbe ? { llmProbe } : {}),
      // 路线 B 不需要 Atlas Vector Search：一对一的相似度在进程内计算
      vectorStrategy: 'in-process-cosine',
      models: providerStatus(),
      /*
       * 微信支付：只报"是否配置"和**回调地址**，不泄漏任何密钥。
       *
       * 为什么要暴露 notifyUrl：2026-10-29 的事故就是回调地址还指着
       * `https://qtvq.cn/api/payment/wechat/notify`（那是 Pages 的），自建 Node 收不到，
       * 用户付了钱、订单一直 created。这个字段让"回调地址对不对"可以从外网一眼核。
       */
      wechatPay: {
        configured: isWechatPayConfigured(),
        notifyUrl: getWechatPayConfig().notifyUrl || null,
        platformPublicKeyConfigured: /BEGIN (PUBLIC KEY|CERTIFICATE)/.test(getWechatPayConfig().platformPublicKey || ''),
      },
    });
  }),
);

export default router;
