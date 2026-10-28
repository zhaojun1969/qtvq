/**
 * 各端「专用端口」：`GET /api/app/bootstrap?channel=<渠道>&version=<版本>`
 *
 * 一次拿到：该端的**能力清单** + 该端的**版本记录** + **更新结论**。
 * 契约与 FTVF 项目一致（`D:\ftvf夫道\packages\shared\src\app-release.ts`），
 * 各端只按 `update` 的结论行动，不再自己比版本号、也不再各自探测一串接口。
 *
 * 无鉴权：这是公开的发布与能力信息，不含密钥与用户数据。
 */
import { corsPreflight, jsonResponse } from '../../lib/http.js';
import {
  APP_CHANNELS,
  APP_CHANNEL_KIND,
  APP_CHANNEL_LABELS,
  DEFAULT_RELEASE,
  buildCapabilities,
  decideUpdate,
  isValidChannel,
  releaseFor,
  RELEASES_SYNCED_AT,
} from '../../lib/app-release.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const channel = String(url.searchParams.get('channel') || '').trim();
  const version = url.searchParams.get('version');

  if (!channel) {
    // 不带参数时返回**渠道目录**：便于端侧自查、也方便运维一眼看到有哪些端
    return jsonResponse(request, {
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
    return jsonResponse(
      request,
      { ok: false, code: 'E_UNKNOWN_CHANNEL', error: `未知渠道 ${channel}`, allowedChannels: APP_CHANNELS },
      400,
    );
  }

  const record = releaseFor(channel);
  const hadRelease = Boolean(record);
  const release = record || { ...DEFAULT_RELEASE, channel };
  // 未上报版本时按"当前即最新"处理：这是**唯一**不会误伤老客户端的默认值
  const current = typeof version === 'string' && version.trim() ? version.trim() : release.version;
  const update = decideUpdate(current, release, { hadRelease });

  return jsonResponse(request, {
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
    capabilities: buildCapabilities(env || {}),
    releasesSyncedAt: RELEASES_SYNCED_AT,
  });
}

export async function onRequestOptions(context) {
  return corsPreflight(context.request);
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return corsPreflight(context.request);
  if (context.request.method !== 'GET') {
    return jsonResponse(context.request, { ok: false, error: 'Method not allowed' }, 405);
  }
  return onRequestGet(context);
}
