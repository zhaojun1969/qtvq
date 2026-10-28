/**
 * 分享卡像素走查（离线，无需登录/付费）
 *
 * 为什么要有它：分享卡是**唯一的传播物料**，但它只存在于 canvas 里 ——
 * 没有 DOM、没有截图基线，改一行字号没人会发现压字。真实卡片又要登录 + 真付费
 * 才能拿到报告，人工点一次成本很高，于是很容易"上线了但没人看过"。
 *
 * 这里用 headless Chrome 把 `card.html` 的三份极端夹具渲染成 PNG，然后做两类断言：
 *   1. **画布尺寸**：避坑/复盘卡必须正好 750×1334（9:16，微信/小红书通用）；
 *   2. **二维码能解**：用 jsQR 直接解整张图，白边（静区）还要 ≥ 4 个模块 ——
 *      "看起来像个码"不算过，四角定位符被圆角裁掉、白边不够都会让真机扫不出来。
 *
 * 不检查像素级"好不好看"：那是人的判断。这里只拦机器能判的硬错。
 *
 * 用法：
 *   node tools/card-walkthrough/run.mjs                 # 跑全部夹具
 *   node tools/card-walkthrough/run.mjs diag long       # 只跑指定夹具
 *   CHROME_PATH="C:\\...\\chrome.exe" node ...          # 指定浏览器
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const u = (p) => pathToFileURL(path.resolve(p)).href;

const jsQR = (await import(u('dist/_qrtest/node_modules/jsqr/dist/jsQR.js'))).default;
const pngjs = await import(u('dist/_qrtest/node_modules/pngjs/lib/png.js'));
const PNG = pngjs.PNG || pngjs.default?.PNG;
const { qrMatrix } = await import(u('js/qr-render.js'));

const EXPECT_URL = 'https://qtvq.cn/r/CARDWALKTHROUGH8x2f';
const MODULES = qrMatrix(EXPECT_URL).length;

/** 各夹具的硬性期望（qrPx/quietPx 与 js/report-share.js 里两处二维码几何保持一致） */
const CASES = {
  diag: { width: 750, height: 1334, qrPx: 150, quietPx: 21 },
  long: { width: 750, height: 1334, qrPx: 150, quietPx: 21 },
  retro: { width: 750, height: 1334, qrPx: 150, quietPx: 21 },
  pair: { width: 750, height: null, qrPx: 132, quietPx: 19 }, // 配对卡高度随正文变化
};

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cands = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return cands.find((p) => p && fs.existsSync(p)) || null;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png', '.css': 'text/css; charset=utf-8' };

function serve() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = path.join(ROOT, url);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** 从截图里量二维码白底的实际宽度（像素级，而不是信任代码里的常量） */
function measureQuietZone(png) {
  const { width, height, data } = png;
  // pngjs 的对象上没有 channels 字段；不自己算的话索引会变成 NaN、量出 0（第一版就栽在这）
  const channels = data.length / (width * height);
  let best = 0;
  for (let y = Math.floor(height * 0.7); y < height; y += 1) {
    let run = 0;
    for (let x = Math.floor(width * 0.6); x < width; x += 1) {
      const i = (y * width + x) * channels;
      const white = data[i] > 235 && data[i + 1] > 235 && data[i + 2] > 235;
      run = white ? run + 1 : 0;
      if (run > best) best = run;
    }
  }
  return best;
}

/**
 * 用异步 spawn，**不能用 spawnSync**：
 * 静态服务器就跑在本进程里，spawnSync 会把事件循环整个卡住 → 服务器无法响应 →
 * Chrome 等到超时也不出图（第一版正是这样挂死的，表现为"命令一直不返回"）。
 */
function runChrome(chrome, args) {
  return new Promise((resolve) => {
    const child = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('close', (code) => resolve({ code, stdout: out }));
    child.on('error', () => resolve({ code: -1, stdout: '' }));
  });
}

async function shoot(chrome, url, outFile, size) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qtvq-card-'));
  await runChrome(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--virtual-time-budget=9000',
    `--user-data-dir=${profile}`,
    `--window-size=${size}`,
    `--screenshot=${outFile}`,
    url,
  ]);
  return profile;
}

async function dumpDims(chrome, url) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qtvq-card-dom-'));
  const r = await runChrome(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--virtual-time-budget=9000',
    `--user-data-dir=${profile}`,
    '--dump-dom',
    url,
  ]);
  const m = /id="dims">(\d+)x(\d+)</.exec(r.stdout || '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

const chrome = findChrome();
if (!chrome) {
  console.error('❌ 找不到 Chrome/Chromium。用 CHROME_PATH 指定，或先安装 Chrome。');
  process.exit(2);
}

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const names = wanted.length ? wanted : Object.keys(CASES);
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/tools/card-walkthrough/card.html`;
const outDir = path.join(HERE, 'out');
fs.mkdirSync(outDir, { recursive: true });

let bad = 0;
console.log(`浏览器：${chrome}`);
console.log(`码字：${MODULES}×${MODULES} 模块 · 期望内容 ${EXPECT_URL}\n`);

for (const name of names) {
  const spec = CASES[name];
  if (!spec) {
    console.log(`❌ 未知夹具 ${name}`);
    bad += 1;
    continue;
  }
  const url = `${base}?name=${name}`;
  const dims = await dumpDims(chrome, url);
  if (!dims) {
    console.log(`❌ ${name}：页面没有画出画布（脚本报错？）`);
    bad += 1;
    continue;
  }
  const out = path.join(outDir, `card-${name}.png`);
  await shoot(chrome, url, out, `${dims.width},${dims.height}`);
  if (!fs.existsSync(out)) {
    console.log(`❌ ${name}：截图失败`);
    bad += 1;
    continue;
  }

  const png = PNG.sync.read(fs.readFileSync(out));
  const problems = [];

  if (png.width !== spec.width) problems.push(`宽度 ${png.width} ≠ ${spec.width}`);
  if (spec.height && png.height !== spec.height) problems.push(`高度 ${png.height} ≠ ${spec.height}`);
  if (!spec.height && png.height < 900) problems.push(`高度 ${png.height} 过小（画布没算对高度？）`);

  const hit = jsQR(new Uint8ClampedArray(png.data), png.width, png.height, { inversionAttempts: 'attemptBoth' });
  if (hit?.data !== EXPECT_URL) problems.push(`二维码解出 ${hit ? JSON.stringify(hit.data) : '(未识别)'}`);

  const whiteRun = measureQuietZone(png);
  const quiet = (whiteRun - spec.qrPx) / 2;
  const modulePx = spec.qrPx / MODULES;
  if (quiet < modulePx * 4 - 0.5) problems.push(`静区只有 ${quiet.toFixed(1)}px ≈ ${(quiet / modulePx).toFixed(2)} 个模块（需 ≥ 4）`);

  if (problems.length) {
    bad += 1;
    console.log(`❌ ${name}  ${png.width}×${png.height}`);
    for (const p of problems) console.log(`     · ${p}`);
  } else {
    console.log(
      `✅ ${name}  ${png.width}×${png.height}  二维码可解 · 白边 ${quiet.toFixed(1)}px ≈ ${(quiet / modulePx).toFixed(2)} 个模块`
    );
  }
}

server.close();
console.log(bad ? `\n失败 ${bad} 个夹具（截图留在 ${path.relative(ROOT, outDir)}）` : `\n全部通过，截图在 ${path.relative(ROOT, outDir)}`);
process.exit(bad ? 1 : 0);
