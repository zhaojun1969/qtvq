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
    try {
      const db = getDB();
      await db.command({ ping: 1 });
      const [users, pitfalls, reports] = await Promise.all([
        db.collection('users').estimatedDocumentCount(),
        db.collection('pitfalls').estimatedDocumentCount(),
        db.collection('reports').estimatedDocumentCount(),
      ]);
      mongo = { connected: true, db: db.databaseName, users, pitfalls, reports };
    } catch (err) {
      mongo = { connected: false, error: err.message };
    }

    return ok(res, {
      service: 'qtvq-server',
      route: 'B-配对报告',
      time: new Date().toISOString(),
      mongo,
      // 路线 B 不需要 Atlas Vector Search：一对一的相似度在进程内计算
      vectorStrategy: 'in-process-cosine',
      models: providerStatus(),
    });
  }),
);

export default router;
