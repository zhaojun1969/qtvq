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
import walletRoutes from './routes/wallet.js';
import wheelRoutes from './routes/wheel.js';
import moderationRoutes from './routes/moderation.js';
import safetyRoutes from './routes/safety.js';
import pitfallsRoutes from './routes/pitfalls.js';
import speechRoutes from './routes/speech.js';
import appBootstrapRoutes from './routes/app-bootstrap.js';
import adminRoutes from './routes/admin.js';
import chatRoutes from './routes/chat.js';
import quotaRoutes from './routes/quota.js';
import authRoutes from './routes/auth.js';
import contactRoutes from './routes/contact.js';
import paymentRoutes from './routes/payment.js';
import trackRoutes from './routes/track.js';
import dataExportRoutes from './routes/data-export.js';

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

// 全局 JSON 上限 1mb（原 256kb）：语音接口的 base64 会把体积放大约 1/3，
// 上限 512KB 的录音在 JSON 里约 683KB —— 256kb 会把它直接判成 413，
// 而前端看到的是"录音发不出去"，与"录音太长"完全不是一回事，极难排查。
/*
 * `verify` 钩子把**原始请求体**存下来。
 *
 * 为什么必须：微信支付回调的验签串是 `timestamp\nnonce\n原始body\n`。
 * `express.json()` 解析后再 `JSON.stringify` 出来的字符串与原文可能不同
 * （空格、键顺序、中文转义），那样验签必然失败 —— 这是移植回调时最容易踩的坑。
 * 只多存一份字符串，开销可忽略。
 */
app.use(
  express.json({
    limit: '1mb',
    verify: (req, res, buf) => {
      if (buf && buf.length) req.rawBody = buf.toString('utf8');
    },
  }),
);

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
/*
 * 自助导出挂在 `/v1/me`：语义是"我自己的东西"，与 `/v1/profile/me` 的读写分开。
 * 单独一个前缀是为了让 nginx 侧只需放行 `/v1/`（已放行），不必新增精确路径。
 */
app.use('/v1/me', dataExportRoutes);
app.use('/v1/profile', profileRoutes);
app.use('/v1/report', reportRoutes);
app.use('/v1/wallet', walletRoutes);
app.use('/v1/moderation', moderationRoutes);
app.use('/v1/safety', safetyRoutes);
app.use('/v1/pitfalls', pitfallsRoutes);
app.use('/v1/wheel', wheelRoutes);
// 未配置 ADMIN_KEY 时整组按 404 处理（见 middleware/admin.js）
app.use('/v1/admin', adminRoutes);

/*
 * `/api/chat` 与 `/api/quota` 迁到本机（2026-10-26）。
 *
 * 同时挂 `/v1/*` 与 `/api/*` 两个前缀是刻意的：
 *   · `/api/*` 是**既有的**前端契约（前端不改），nginx 把这两个路径直接转到本机；
 *   · `/v1/*` 供新端（App/鸿蒙）与内部调用使用，避免它们依赖"历史路径"。
 * 这样 nginx 只需换 upstream，回滚也只需把 upstream 换回去。
 */
app.use('/v1/chat', chatRoutes);
app.use('/v1/quota', quotaRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/quota', quotaRoutes);

/*
 * 账号与会话（2026-10-26 迁到本机）。
 * 注意 `/api/auth` 是**精确路径**：`/api/auth/sms`、`/api/auth/wechat*`、`/api/auth/delete`
 * 仍在 Pages 上（依赖短信/微信 SDK 与通知邮件）。nginx 用 `location =` 只把这两个精确路径转过来。
 */
app.use('/v1/auth', authRoutes);
app.use('/api/auth', authRoutes);

/* 站内留言（2026-10-26 迁到本机）：只写境内 Mongo + 境内 SMTP 通知，不再跨境 */
app.use('/v1/contact', contactRoutes);
app.use('/api/contact', contactRoutes);

/*
 * 微信支付（2026-10-27 · 再改造实施书 P0-T0.1）。
 * 只服务新栈的报告/转盘订单（前缀 rpt_/whl_）；存量会员支付仍在 Cloudflare Functions，一行不改。
 */
app.use('/v1/payment', paymentRoutes);

/* 埋点（P0-T0.3）：批量上报 + 按月分表 + eventId 去重。白名单见 routes/track.js */
app.use('/v1/track', trackRoutes);

/*
 * 迁移自 Cloudflare Pages 的 `/api/speech`（语音识别）。
 * 路径**故意保留 `/api/` 前缀**而不是改成 `/v1/`：
 *   · 前端、小程序、H5、鸿蒙与桌面壳都按 `/api/speech` 调用，改路径就要同时改 5 个端；
 *   · 保留原路径，切换与回滚都只是 nginx 上的一条 location（秒级）。
 * 这是"strangler"迁移的标准做法：**先保持契约，再换实现**。
 */
app.use('/api/speech', speechRoutes);

/*
 * 各端「专用端口」。**故意同时挂两个前缀**：
 *   · `/api/app/bootstrap` —— 迁移到自建 Node 之后对外提供服务的正式路径（nginx 切流后生效）；
 *   · `/v1/app/bootstrap`  —— 用于**切流之前**与线上 Pages 做双端比对。
 * nginx 早已把 `/v1/` 反代到本进程，所以闸门（`tools/scripts/check-app-bootstrap-gate.mjs`）
 * 不必提前改 nginx 就能读到 Node 侧的真实输出 —— 这是"验证先于切换"的关键。
 * 契约必须与 `functions/api/app/bootstrap.js` 逐字段一致，否则能力清单会以错误值下发。
 */
app.use('/api/app/bootstrap', appBootstrapRoutes);
app.use('/v1/app/bootstrap', appBootstrapRoutes);

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

/**
 * 连库带重试，且**不阻塞监听**。
 *
 * 之前是 `await connectDB()` 再 `listen`，结果是：MongoDB 不可用时进程直接退出，
 * systemd 按 Restart=always 反复重启 —— 表现为 `systemctl is-active` 显示 active、
 * 但端口完全没有响应，最容易被误判成「代码坏了」。
 * 现在先监听再连库：`/v1/health` 会如实报 `mongo.connected: false`，一眼就能看出是数据库问题。
 */
let connectAttempt = 0;
let dbReady = false;

async function connectWithRetry() {
  connectAttempt += 1;
  try {
    await connectDB();
    dbReady = true;
    console.log(`[boot] MongoDB 已连接：${env.mongoDb}`);
  } catch (err) {
    const delayMs = Math.min(30000, 2000 * connectAttempt);
    console.error(`[boot] ❌ MongoDB 连接失败（第 ${connectAttempt} 次）：${err.message}`);
    console.error(
      `[boot]    ${Math.round(delayMs / 1000)}s 后重试。请依次检查：` +
        ` 1) systemctl is-active mongod  ` +
        `2) .env 里的 MONGO_URI=${env.mongoUri.replace(/\/\/[^@]*@/, '//***@')}` +
        ` 3) 防火墙/安全组是否放通 27017`,
    );
    setTimeout(() => {
      void connectWithRetry();
    }, delayMs);
  }
}

export function isDbReady() {
  return dbReady;
}

async function main() {
  const status = providerStatus();
  console.log('[boot] 模型配置:', JSON.stringify(status));
  if (!status.embed.configured) {
    console.warn('[boot] ⚠️  Embedding 未配置：资料向量将无法生成，报告会降级为字面相似度');
  }
  if (!status.llm.configured) {
    console.warn('[boot] ⚠️  对话模型未配置：报告将使用确定性兜底文案');
  }

  // 先监听：保证 /v1/health 在数据库故障时依然可答
  const server = app.listen(env.port, () => {
    console.log(`🚀 QTVQ server (路线B 配对报告) on :${env.port}`);
    console.log(`[boot] 健康检查：curl -s localhost:${env.port}/v1/health`);
  });

  void connectWithRetry();

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
