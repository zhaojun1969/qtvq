/**
 * 计算本地 `server/src` 的构建指纹，并与线上 /v1/health 的 build.sha 比对。
 *
 * 用法：
 *   node tools/scripts/server-build-sha.mjs            # 只算本地
 *   node tools/scripts/server-build-sha.mjs --check    # 同时请求线上并比对
 *
 * 为什么要这个：部署验证长期靠"找一个能远程看到的痕迹"，很脆（见 §9.24/§9.30）。
 * 服务端现在在 /v1/health 里报 build.sha（启动时对 server/src 全量排序哈希），
 * 于是任何一次服务端改动都能用"本地算一遍、线上读一遍、比对"来确定是否落地。
 *
 * 注意：只比 `server/src`。服务器上的 .env / data / node_modules 不参与哈希，
 * 所以配置或数据的差异不会造成误判。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SRC = path.resolve('server/src');
const BASE = process.env.QTVQ_API_BASE || 'https://qtvq.cn';

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, base, out);
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out;
}

export function localSha() {
  const files = walk(SRC).sort();
  const hash = crypto.createHash('sha256');
  let n = 0;
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    // 行尾归一化（CRLF→LF）后再哈希：打包脚本 upload-server-bundle.py 会对文本文件做同样转换，
    // 而线上指纹算的是**转换后**的字节。原先对原始字节哈希 ⇒ 工作区里带 CRLF 的文件
    // 本地与线上永远不同，看起来像"部署没生效"（2026-10-11 在 aliyun-nls.js 上实测）。
    // 三处实现必须一致：本文件、server/src/lib/build-info.js、upload-server-bundle.py。
    hash.update(Buffer.from(fs.readFileSync(path.join(SRC, rel))).toString('binary').replace(/\r\n/g, '\n'), 'binary');
    hash.update('\0');
    n += 1;
  }
  return { sha: hash.digest('hex').slice(0, 16), files: n };
}

const local = localSha();
console.log(`本地 server/src 指纹: ${local.sha}  （${local.files} 个文件）`);

if (!process.argv.includes('--check')) {
  process.exit(0);
}

let live;
try {
  const res = await fetch(`${BASE}/v1/health`, { headers: { 'Cache-Control': 'no-cache' } });
  const data = await res.json();
  live = data?.data?.build || data?.build || null;
  if (!live) {
    console.log(`线上 /v1/health 没有 build 字段（HTTP ${res.status}）`);
    console.log('→ 说明服务器上跑的还是**没有这个指纹的旧版本**，本次改动未部署。');
    process.exit(2);
  }
} catch (err) {
  console.log(`请求线上失败：${err.message}（网络问题？不要据此判断未部署）`);
  process.exit(3);
}

console.log(`线上 build.sha    : ${live.sha}  （${live.files} 个文件，启动于 ${live.computedAt}）`);
if (live.sha === local.sha) {
  console.log('✅ 一致：线上跑的代码与本地完全一致（server/src 全量哈希相同）');
  process.exit(0);
}
console.log('❌ 不一致：线上不是这份代码。可能原因：未部署 / 部署了但未重启 / 服务器上有别的改动。');
process.exit(1);
