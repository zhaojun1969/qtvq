/**
 * 微信小程序上传（miniprogram-ci）
 *
 * 为什么要有这个脚本
 * ----------------
 * 「新版本上传」一直挂在遗留清单上，原因是**这一步在开发者工具里点**：
 * 需要人在场、需要记得版本号怎么写、上传完还得去后台点提交审核。
 * 消息里说"已构建好、请手动上传"，实际上等于"这件事没人会做"。
 *
 * 现在把它做成一条命令：`npm run mp:upload -- --version 1.0.7 --desc "…"`。
 * 仍然需要**一次**人工准备（下载上传私钥），但那是一次性的。
 *
 * 密钥怎么来（微信后台 → 开发 → 开发设置 → 小程序代码上传）
 * -------------------------------------------------------
 *   1. 生成密钥，下载 `private.<appid>.key`，**只显示一次**；
 *   2. 放到仓库根目录（已在 .gitignore 里，不会误提交）；
 *   3. 或者用环境变量 `MP_PRIVATE_KEY_PATH` 指到别处。
 *
 * 这个脚本刻意**不自动提交审核**
 * ----------------------------
 * 上传（开发版）与"提交审核"是两件事：提交审核要选类目、填功能页面、写测试账号，
 * 而且一旦提交就进入微信的审核流程（驳回会计入记录）。自动化到"上传"为止，
 * 提交那一步留给人 —— 那是需要判断的地方。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const PROJECT_DIR = path.join(ROOT, 'apps/qtvq-uni/dist/build/mp-weixin');
const MANIFEST = path.join(ROOT, 'apps/qtvq-uni/src/manifest.json');

function parseArgs(argv) {
  const out = { version: '', desc: '', robot: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--version' || a === '-v') out.version = argv[++i] || '';
    else if (a === '--desc' || a === '-d') out.desc = argv[++i] || '';
    else if (a === '--robot' || a === '-r') out.robot = Number(argv[++i] || 1);
  }
  return out;
}

function fail(message, hint) {
  console.error(`\n❌ ${message}`);
  if (hint) console.error(`\n${hint}\n`);
  process.exit(1);
}

function readAppId() {
  try {
    const raw = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    return raw?.['mp-weixin']?.appid || '';
  } catch {
    return '';
  }
}

function findKey(appid) {
  const fromEnv = process.env.MP_PRIVATE_KEY_PATH;
  const candidates = [
    fromEnv,
    path.join(ROOT, `private.${appid}.key`),
    path.join(ROOT, 'private.key'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const args = parseArgs(process.argv.slice(2));
const appid = readAppId();

if (!appid) {
  fail(
    'manifest.json 里没有 mp-weixin.appid',
    '先注册小程序并把 appid 填进 apps/qtvq-uni/src/manifest.json 的 mp-weixin.appid。',
  );
}

if (!fs.existsSync(path.join(PROJECT_DIR, 'app.json'))) {
  fail(
    `构建产物不存在：${path.relative(ROOT, PROJECT_DIR)}`,
    '先构建：cd apps/qtvq-uni && npm run build:mp-weixin',
  );
}

/*
 * 产物里的 appid 必须与 manifest 一致。
 * 不一致的上传是"用 A 的包传到 B 的号上"，微信会直接拒绝，
 * 但更常见的情况是它没拒绝 —— 那才是灾难：你以为发了新版本，实际发到了别的号。
 */
try {
  const proj = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'project.config.json'), 'utf8'));
  if (proj.appid && proj.appid !== appid) {
    fail(
      `产物 appid(${proj.appid}) 与 manifest(${appid}) 不一致`,
      '重新构建一次；若仍不一致，检查 apps/qtvq-uni/src/manifest.json 是否被改过。',
    );
  }
} catch (err) {
  fail(`读取 project.config.json 失败：${err.message}`, '重新构建后再试。');
}

const keyPath = findKey(appid);
if (!keyPath) {
  fail(
    '找不到上传私钥',
    [
      '这一步只能人工做一次（微信不允许代生成）：',
      '  1. 打开 mp.weixin.qq.com → 开发 → 开发设置 → 小程序代码上传',
      `  2. 生成密钥，下载 private.${appid}.key（只显示一次）`,
      `  3. 放到仓库根目录：D:\\qtvq\\private.${appid}.key（已在 .gitignore）`,
      '  4. 重跑本命令',
      '',
      '也可以不配密钥，直接在微信开发者工具里点「上传」—— 效果相同，只是要人在场。',
    ].join('\n'),
  );
}

let ci;
try {
  ci = await import('miniprogram-ci');
} catch {
  fail(
    '缺少依赖 miniprogram-ci',
    '安装一次即可：npm i -D miniprogram-ci（约 20MB，只在上传时用）',
  );
}

const version = args.version || `1.0.${Math.floor(Date.now() / 1000) % 1000}`;
const desc = args.desc || `ci upload ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;

/**
 * 版本号必须比线上大，否则后台会显示"版本号已存在"。
 * 这里不自动 +1：自动改版本号会让"线上到底是哪一版"变得不可追溯。
 * 只做提示，不替人决定。
 */
console.log(`\n项目：${path.relative(ROOT, PROJECT_DIR)}`);
console.log(`appid：${appid}`);
console.log(`版本：${version}`);
console.log(`描述：${desc}\n`);

const project = new ci.Project({
  appid,
  type: 'miniProgram',
  projectPath: PROJECT_DIR,
  privateKeyPath: keyPath,
  ignores: ['node_modules/**/*'],
});

try {
  const result = await ci.upload({
    project,
    version,
    desc,
    setting: {
      // 与开发者工具默认一致：压缩、不启用 ES6 转 ES5（本项目产物已是 ES5 兼容语法）
      minify: true,
      es6: false,
      es7: false,
      codeProtect: false,
      autoPrefixWXSS: true,
    },
    robot: Number.isFinite(args.robot) ? args.robot : 1,
    onProgressUpdate: (info) => {
      if (typeof info === 'string') return;
      if (info && info._msg) return;
    },
  });
  console.log('✅ 上传成功（开发版）');
  console.log(JSON.stringify(result, null, 2).slice(0, 600));
  console.log(
    [
      '',
      '下一步（人工）：',
      '  1. mp.weixin.qq.com → 版本管理 → 开发版本 → 提交审核',
      '  2. 提审前确认：类目含「深度合成-AI问答」、已填算法备案编号、',
      '     功能页面填 pages/index/index、测试账号可用',
      '  3. 审核通过后点「发布」—— 不点发布，用户拿到的还是旧版本',
    ].join('\n'),
  );
} catch (err) {
  fail(`上传失败：${err?.message || err}`, '常见原因：私钥与 appid 不匹配、IP 白名单未放行、产物过大。');
}
