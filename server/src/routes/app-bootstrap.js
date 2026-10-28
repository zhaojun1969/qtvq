/**
 * 各端「专用端口」：`GET /api/app/bootstrap?channel=<渠道>&version=<版本>`（自建 Node 版本）
 *
 * 契约与 `functions/api/app/bootstrap.js` **逐字段对齐**：一次拿到能力清单 + 版本记录 + 更新结论。
 * 无鉴权：这是公开的发布与能力信息，不含密钥与用户数据。
 *
 * 为什么同时挂在 `/v1/app/bootstrap`：
 * nginx 早已把 `/v1/` 反代到本进程，而 `/api/` 还指向 Cloudflare Pages。
 * 因此**在切换 `/api/` 之前**，闸门就能通过 `/v1/app/bootstrap` 与线上 Pages 做双端比对 ——
 * 不必为了验证而提前动 nginx（切流前的零风险验证路径）。
 */
import { Router } from 'express';
import {
  APP_CHANNELS,
  APP_CHANNEL_KIND,
  APP_CHANNEL_LABELS,
  DEFAULT_RELEASE,
  buildCapabilities,
  decideUpdate,
  isValidChannel,
  releaseFor,
} from '../lib/app-release.js';
import { GENERATED_AT as RELEASES_SYNCED_AT } from '../data/app-releases.generated.js';

const router = Router();

router.get('/', (req, res) => {
  const channel = String(req.query.channel || '').trim();
  const version = req.query.version;

  if (!channel) {
    // 不带参数时返回**渠道目录**：便于端侧自查、也方便运维一眼看到有哪些端
    return res.json({
      ok: true,
      apiVersion: 1,
      channels: APP_CHANNELS.map((c) => ({
        channel: c,
        label: APP_CHANNEL_LABELS[c],
        kind: APP_CHANNEL_KIND[c],
      })),
      releasesSyncedAt: RELEASES_SYNCED_AT,
      usage: 'GET /api/app/bootstrap?channel=wechat&version=1.0.6',
    });
  }

  if (!isValidChannel(channel)) {
    return res.status(400).json({
      ok: false,
      code: 'E_UNKNOWN_CHANNEL',
      error: `未知渠道 ${channel}`,
      allowedChannels: APP_CHANNELS,
    });
  }

  const record = releaseFor(channel);
  const hadRelease = Boolean(record);
  const release = record || { ...DEFAULT_RELEASE, channel };
  // 未上报版本时按"当前即最新"处理：这是**唯一**不会误伤老客户端的默认值
  const current = typeof version === 'string' && version.trim() ? version.trim() : release.version;
  const update = decideUpdate(current, release, { hadRelease });

  return res.json({
    ok: true,
    apiVersion: 1,
    channel,
    label: APP_CHANNEL_LABELS[channel],
    kind: APP_CHANNEL_KIND[channel],
    serverTimeUtc: new Date().toISOString(),
    // 客户端没上报版本时如实说明，避免把"服务端默认"当成"客户端版本"
    clientVersion: typeof version === 'string' && version.trim() ? version.trim() : null,
    release,
    update,
    capabilities: buildCapabilities(process.env),
    releasesSyncedAt: RELEASES_SYNCED_AT,
  });
});

router.options('/', (req, res) => res.status(204).end());
router.all('/', (req, res) => res.status(405).json({ ok: false, error: 'Method not allowed' }));

export default router;
