/**
 * 服务端构建指纹（用于"这次改动到底有没有部署上去"的远程核验）
 *
 * 为什么需要：本项目在部署验证上反复吃过亏（§9.24：解压失败但命令"跑完了"；
 * §9.30：链接过期被报成 gzip 错）。当时的办法是找"可远程观察的落地特征"，
 * 但每个功能都得单独找（localWords 计数、systemctl is-active…），很脆。
 *
 * 这里给一个**通用**的落地特征：启动时把 `server/src` 下所有文件按路径排序后做 SHA-256，
 * 在 `/v1/health` 里报出来。本地用 tools/scripts/server-build-sha.mjs 算同一个值，
 * 两边一比即可判定"线上跑的就是这份代码"，不必开 SSH 看文件。
 *
 * 只哈希 `server/src`（不含 .env、data/、node_modules），所以指纹只随代码变化，
 * 不会因为服务器上的配置或数据不同而误判。哈希内容包含相对路径，重命名/增删文件都会变。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** server/src/lib -> server/src */
const SRC_ROOT = path.resolve(HERE, '..');

function walk(dir, base = dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
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

/**
 * 行尾归一化（CRLF → LF）后再参与哈希。
 *
 * 为什么必须归一化：打包脚本 `tools/scripts/upload-server-bundle.py` 的 `add_tree()`
 * 会对文本文件执行 `data.replace(b"\r\n", b"\n")`（有意为之：本仓库 `core.autocrlf=true`，
 * CRLF 打进 Linux 包会让 shell 报 `line 4: $'\r': command not found`，且只有部分文件中招）。
 * 而指纹原先对**原始字节**哈希 → 工作区里 CRLF 的文件，其本地哈希与线上（已转 LF）永远不同，
 * 看起来就像"部署没生效"。2026-10-11 实测：`server/src/lib/aliyun-nls.js` 因 `Copy-Item`
 * 带上了 212 个 CRLF（7895 字节），转 LF 后恰好 7683 字节 = 线上大小 —— 就是这个原因。
 *
 * 为什么可以**无条件**归一化（不区分文本/二进制）：
 * 变换在**三处实现里一致地施加**。二进制文件在打包时不被改写，但两侧哈希都会做同样的归一化，
 * 所以依然相等；文本文件则是把"打包时的转换"提前到了哈希里。两边对称 ⇒ 不会引入新的误判。
 * 三处实现必须保持同一算法：本文件、`tools/scripts/server-build-sha.mjs`、
 * `tools/scripts/upload-server-bundle.py` 的 `source_fingerprint()`。
 */
function normalizeEol(buf) {
  return Buffer.from(buf).toString('binary').replace(/\r\n/g, '\n');
}

/**
 * 计算 `server/src` 的指纹。
 * @returns {{ sha: string, files: number, computedAt: string }}
 */
export function computeBuildInfo() {
  const files = walk(SRC_ROOT).sort();
  const hash = crypto.createHash('sha256');
  let hashed = 0;
  for (const rel of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(SRC_ROOT, rel));
    } catch {
      continue; // 读不到就跳过：指纹仍可用，只是不覆盖这个文件
    }
    hash.update(rel);
    hash.update('\0');
    hash.update(normalizeEol(content), 'binary');
    hash.update('\0');
    hashed += 1;
  }
  return {
    sha: hash.digest('hex').slice(0, 16),
    files: hashed,
    computedAt: new Date().toISOString(),
  };
}

export const buildInfo = computeBuildInfo();
