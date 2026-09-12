/**
 * QTVQ 新服务入口（路线 B · AI 配对报告）
 *
 * 这是「strangler（绞杀者）」模式的增长侧：
 * 新功能写在新栈上，老系统（Cloudflare Pages Functions：登录 / 支付 / 会员 / 问答）
 * 原样保留，通过 `middleware/auth.js` 的 `/api/auth/me` 回源校验共享同一批用户。
 * 因此本次迁移**不需要停机、不需要数据搬迁、可以随时回滚**。
 */
import express from 'express';
import cors from 'cors';
import { env, providerStatus } from './config/env.js';
import { connectDB, closeDB } from './config/db.js';
import { errorHandler, ok, wrap, ApiError } from './lib/http.js';
import { signLocalToken } from './middleware/auth.js';
import healthRoutes from './routes/health.js';
import profileRoutes from './routes/profile.js';
import reportRoutes from './routes/report.js';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);

// CORS 必须回显具体 Origin：`origin:'*' + credentials:true` 是浏览器直接拒绝的非法组合
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // 同源 / 服务端调用
      if (env.corsOrigins.includes(origin)) return cb(null, true);
      return cb(new ApiError(403, `CORS 拒绝：${origin}`, 'E_CORS'));
    },
    credentials: true,
  }),
);

app.use(express.json({ limit: '256kb' }));

// 轻量请求日志（生产建议换成结构化日志）
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path === '/v1/health') return;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

app.use('/v1/health', healthRoutes);
app.use('/v1/profile', profileRoutes);
app.use('/v1/report', reportRoutes);

// 开发/内测用：直接签发本地 token（生产 ALLOW_DEV_LOGIN 必须为 0）
app.post(
  '/v1/auth/dev-login',
  wrap(async (req, res) => {
    if (!env.allowDevLogin) throw new ApiError(404, 'Not found', 'E_NOT_FOUND');
    const uid = String(req.body?.uid || '').trim();
    if (!uid) throw new ApiError(400, '缺少 uid', 'E_NO_UID');
    return ok(res, { token: signLocalToken(uid), uid, warning: 'DEV ONLY' });
  }),
);

app.use((req, res) => {
  res.status(404).json({ code: 404, error: `未知接口：${req.method} ${req.path}` });
});

app.use(errorHandler);

async function main() {
  const status = providerStatus();
  console.log('[boot] 模型配置:', JSON.stringify(status));
  if (!status.embed.configured) {
    console.warn('[boot] ⚠️  Embedding 未配置：资料向量将无法生成，报告会降级为字面相似度');
  }
  if (!status.llm.configured) {
    console.warn('[boot] ⚠️  对话模型未配置：报告将使用确定性兜底文案');
  }

  await connectDB();
  console.log(`[boot] MongoDB 已连接：${env.mongoDb}`);

  const server = app.listen(env.port, () => {
    console.log(`🚀 QTVQ server (路线B 配对报告) on :${env.port}`);
  });

  const shutdown = async (signal) => {
    console.log(`[shutdown] ${signal}`);
    server.close();
    await closeDB().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[fatal] 启动失败:', err);
  process.exit(1);
});

export default app;
