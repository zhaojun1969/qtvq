/**
 * 线上 JS 模块导入/导出一致性检查。
 *
 * 背景：今天已出现 5 次"用了函数忘 import / import 了不存在的导出"——这类问题
 * 打包不报、浏览器一加载就整条模块链断掉，表现是"按钮点了没反应"。
 * 这里直接抓线上文件，逐个核对 import 的名字是否真的被导出。
 */
const BASE = 'https://qtvq.cn/';
const cache = new Map();

async function get(path) {
  if (cache.has(path)) return cache.get(path);
  const r = await fetch(BASE + path + '?check=' + Date.now());
  const t = await r.text();
  cache.set(path, t);
  return t;
}

function exportsOf(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  if (/export\s+default/.test(src)) names.add('default');
  return names;
}

const seen = new Set();
const problems = [];

async function walk(path) {
  if (seen.has(path)) return;
  seen.add(path);
  const src = await get(path);
  for (const m of src.matchAll(/import\s+(?:([\w*\s{},]+)\s+from\s+)?['"](\.[^'"]+)['"]/g)) {
    const rawSpec = m[2];
    const target = new URL(rawSpec, BASE + path).pathname.replace(/^\//, '');
    const names = (m[1] || '')
      .replace(/[{}]/g, ' ')
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter((s) => s && s !== '*' && !s.startsWith('*'));
    let targetSrc = '';
    try {
      targetSrc = await get(target);
    } catch {
      problems.push(`${path} → 无法加载 ${target}`);
      continue;
    }
    const ex = exportsOf(targetSrc);
    for (const n of names) {
      if (n && !ex.has(n)) problems.push(`${path} 引入 ${n}，但 ${target} 并未导出它`);
    }
    await walk(target);
  }
}

console.log('=== 从首页模块链开始核对 ===');
await walk('js/home.js');
console.log(`  已检查 ${seen.size} 个模块：${[...seen].join(', ')}`);
console.log('');

if (problems.length === 0) {
  console.log('✅ 模块链 imports/exports 全部对得上 —— 说明"点了没反应"不是漏引入造成');
} else {
  console.log('❌ 发现问题（这些都会让整条模块链断掉、按钮无反应）：');
  for (const p of problems) console.log('   · ' + p);
}
