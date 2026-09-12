/** 健康检查：不泄漏密钥，只报「是否配置」 */
import { Router } from 'express';
import { providerStatus } from '../config/env.js';
import { getDB } from '../config/db.js';
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

    return ok(res, {
      service: 'qtvq-server',
      route: 'B-配对报告',
      time: new Date().toISOString(),
      mongo,
      ...(hint ? { hint } : {}),
      // 路线 B 不需要 Atlas Vector Search：一对一的相似度在进程内计算
      vectorStrategy: 'in-process-cosine',
      models: providerStatus(),
    });
  }),
);

export default router;
