#!/usr/bin/env node
/**
 * 渠道名契约：客户端 `runtimeTag()` 与服务端 `APP_CHANNELS` 必须是同一套名字
 *
 * 为什么要有
 * ----------
 * 2026-10-28 实测发现的真 BUG（本条检查器就是它的墓碑）：
 *   · 客户端 `apps/qtvq-uni/src/utils/update.js` 的 `runtimeTag()` 返回
 *     `mp-weixin` / `mp-alipay` / `h5` / `app` …
 *   · 服务端 `server/src/lib/app-release-core.js` 的 `APP_CHANNELS` 只认
 *     `wechat` / `alipay` / `web` / `android` / `ios` …
 *   → 线上 `GET /api/app/bootstrap?channel=mp-weixin` 返回 **400 E_UNKNOWN_CHANNEL**，
 *     客户端 `fetchBootstrap()` 见 `ok === false` 就返回 null，于是
 *     **所有端的能力清单与更新结论从未生效过**，一直退回静态 version.json。
 *
 * 为什么这事拖了这么久没被发现：
 *   接口能连通（HTTP 是 200 分的 400）、客户端"拿不到就兜底"、功能表面正常。
 *   这类"两端各自定义同一概念"的分叉只能靠断言，靠人工点不出来。
 *
 * 断言
 * ----
 *   1. `runtimeTag()` 里每一个 `return '<名字>'` 都必须出现在 APP_CHANNELS 中
 *   2. `runtimeTag()` 的兜底返回值也必须在 APP_CHANNELS 里（否则未知端一定 400）
 *   3. 反向提示：APP_CHANNELS 里没有对应客户端分支的渠道只做提示，不判失败
 *      （mp360 等属服务端预留，客户端还没有构建端）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const problems = [];
const hints = [];

const UPDATE_JS = path.join(ROOT, 'apps', 'qtvq-uni', 'src', 'utils', 'update.js');
const CORE_JS = path.join(ROOT, 'server', 'src', 'lib', 'app-release-core.js');

for (const f of [UPDATE_JS, CORE_JS]) {
  if (!fs.existsSync(f)) {
    console.error(`[check-channel-contract] ❌ 找不到 ${path.relative(ROOT, f)}`);
    process.exit(1);
  }
}

const { APP_CHANNELS } = await import(new URL(`file://${CORE_JS.replace(/\\/g, '/')}`).href);

const src = fs.readFileSync(UPDATE_JS, 'utf8');
const fnStart = src.indexOf('export function runtimeTag()');
if (fnStart === -1) {
  console.error('[check-channel-contract] ❌ update.js 里找不到 runtimeTag()');
  process.exit(1);
}
// 从函数头开始，按大括号配平取函数体（比正则贪婪匹配到文件尾安全）
let depth = 0;
let started = false;
let fnEnd = -1;
for (let i = src.indexOf('{', fnStart); i < src.length; i += 1) {
  const ch = src[i];
  if (ch === '{') {
    depth += 1;
    started = true;
  } else if (ch === '}') {
    depth -= 1;
    if (started && depth === 0) {
      fnEnd = i;
      break;
    }
  }
}
if (fnEnd === -1) {
  console.error('[check-channel-contract] ❌ runtimeTag() 的大括号不配平');
  process.exit(1);
}
const body = src.slice(fnStart, fnEnd + 1);

/** 所有 return 'xxx'（含条件编译块里的） */
const returns = [...body.matchAll(/return\s+'([a-zA-Z0-9_-]+)'/g)].map((m) => m[1]);

if (returns.length === 0) {
  problems.push('runtimeTag() 里没有找到任何 return \'<渠道名>\' —— 检查器无法判定，先修解析');
}

for (const name of returns) {
  if (!APP_CHANNELS.includes(name)) {
    problems.push(`runtimeTag() 返回 "${name}"，但服务端 APP_CHANNELS 里没有 → 该端请求会 400 E_UNKNOWN_CHANNEL`);
  }
}

/** 兜底 return（函数体最后一个 return，且不在 #ifdef 里） */
const tail = body.slice(body.lastIndexOf('#endif'));
const tailReturns = [...tail.matchAll(/return\s+'([a-zA-Z0-9_-]+)'/g)].map((m) => m[1]);
if (tailReturns.length === 0) {
  problems.push('runtimeTag() 缺少条件编译之外的兜底 return —— 未知端会拿到 undefined，URL 变成 channel=undefined');
} else {
  for (const name of tailReturns) {
    if (!APP_CHANNELS.includes(name)) {
      problems.push(`runtimeTag() 的兜底返回 "${name}" 不在 APP_CHANNELS 里`);
    }
  }
}

/** 服务端有、客户端没有分支的渠道：提示（不算错，属于预留） */
const clientTags = new Set(returns);
const noClient = APP_CHANNELS.filter((c) => !clientTags.has(c));
if (noClient.length) hints.push(`服务端有、客户端暂无对应分支：${noClient.join(', ')}`);

/** 顺带确认 bootstrap 的 URL 拼法没被改坏（两端路径必须一致） */
if (!src.includes('/api/app/bootstrap')) {
  problems.push('update.js 里没有 `/api/app/bootstrap` —— 专用端口路径被改了？服务端只挂了这个前缀');
}
if (!src.includes('/release/version.json')) {
  problems.push('update.js 里没有 `/release/version.json` —— 静态版本清单兜底路径被改了？');
}

if (problems.length === 0) {
  console.log(
    `[check-channel-contract] ✅ runtimeTag() 的 ${returns.length} 个返回值全部在 APP_CHANNELS（${APP_CHANNELS.length} 个渠道）内`,
  );
  for (const h of hints) console.log('  · ' + h);
  process.exit(0);
}

console.error(`[check-channel-contract] ❌ ${problems.length} 处不符合：`);
for (const p of problems) console.error('  ' + p);
process.exit(1);
