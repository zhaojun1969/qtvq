/**
 * Pages Functions 打包预检（用 esbuild，与 Cloudflare 部署时的打包规则一致）
 *
 * 为什么必须单独做这一步：Pages 的 Functions 是**部署时**才用 esbuild 打包的，
 * 所以"本地看着没问题、一部署就失败"只能等部署才发现。实际踩过两次：
 *   · 重复导出 → `Multiple exports with the same name "isValidChannel"`（部署重试 3 次全失败）；
 *   · 依赖打包器才支持的 JSON 裸导入 → 在 Node 里直接加载会报 ERR_IMPORT_ATTRIBUTE_MISSING，
 *     而部署能过（说明两边规则不同，不能只用 `node` 跑一遍来代替）。
 * 现在把每个入口都打包一遍，把这类错误提前到本地。
 *
 * 实现细节（都踩过坑）：
 *   · 用 esbuild 的 **JS API**，不起子进程：Node 22 下 `execFileSync('npx.cmd', …)` 会被拒（EINVAL），
 *     加了 `shell:true` 才能跑；而子进程方式的报错信息还经常是空的，排查很费劲。
 *   · 输出写到系统临时目录，不污染仓库。
 *
 * 用法：node tools/scripts/check-functions-bundle.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = process.cwd();
const FUNCTIONS = path.join(ROOT, 'functions');

// 从仓库根解析 esbuild（它是 vite 的依赖，根目录可解析到）
const require = createRequire(path.join(ROOT, 'package.json'));
let esbuild;
try {
  esbuild = require('esbuild');
} catch (err) {
  console.log(`⏭️  跳过：本地没有 esbuild（${err.message.split('\n')[0]}）`);
  console.log('   root 下执行 npm install 后再跑；CI 里应保证有依赖。');
  process.exit(0);
}

/**
 * 找出所有路由入口：functions 下所有 .js，跳过 lib 与 data 两个目录。
 *
 * 写注释时的坑（2026-09-21 连踩两次）：不要在注释里写含"星号紧跟斜杠"的 glob 字面量 ——
 * 那三个字符正好是块注释的结束符，注释会被提前截断，报错位置看着像注释行、其实问题在字面量。
 */
function findEntries(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['lib', 'data', 'node_modules'].includes(e.name)) continue;
      findEntries(p, out);
    } else if (e.name.endsWith('.js') && !e.name.endsWith('_middleware.js')) {
      out.push(p);
    }
  }
  return out;
}

const entries = findEntries(FUNCTIONS).sort();
console.log(`=== Pages Functions 打包预检：${entries.length} 个入口（esbuild ${esbuild.version}）===`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qtvq-fn-'));
let fail = 0;
try {
  for (const entry of entries) {
    const rel = path.relative(ROOT, entry).replace(/\\/g, '/');
    try {
      await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: 'esm',
        platform: 'neutral',
        target: 'es2022',
        outfile: path.join(tmp, 'out.js'),
        logLevel: 'silent',
        // Cloudflare 的打包器认识裸 JSON 导入；这里打开同样的能力，
        // 否则会因为 rag-index.json 报"需要 import attribute"的假失败
        loader: { '.json': 'json' },
      });
      console.log(`  ✅ ${rel}`);
    } catch (err) {
      fail += 1;
      console.log(`  ❌ ${rel}`);
      for (const e of err.errors || []) {
        console.log(`      ${e.text}${e.location ? ` @ ${e.location.file}:${e.location.line}` : ''}`);
      }
      if (!err.errors?.length) console.log(`      ${err.message}`);
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('');
if (fail) {
  console.log(`❌ ${fail} 个入口打包失败 —— 直接部署也会失败，先修这里`);
  process.exit(1);
}
console.log('✅ 全部入口可打包（与 Cloudflare 部署时的规则一致）');
