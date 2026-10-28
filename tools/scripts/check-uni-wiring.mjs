/**
 * 小程序接线检查（构建前的静态验证）
 *
 * 今天已多次出现"打包能过、一点就报错"的问题（漏 import、函数重名、路径不存在）。
 * 这个脚本在**构建前**把这些挡下来：
 *   ① 每个 .vue 里 import 的名字，是否真的从对应模块导出
 *   ② 页面里调用的 api/ 函数，是否真的存在（防止写成不存在的名字）
 *   ③ pages.json 注册的页面文件是否存在；navigateTo/switchTab 的目标是否已注册
 *   ④ 同名函数重复声明（会静默覆盖，最难查）
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'apps/qtvq-uni/src';
let problems = 0;
const bad = (s) => {
  console.log('  ❌ ' + s);
  problems += 1;
};

/* 收集所有模块的导出 */
const exportsOf = (src) => {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const p of m[1].split(',')) {
      const n = p.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  return names;
};

const jsFiles = [];
const vueFiles = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) jsFiles.push(p);
    else if (e.name.endsWith('.vue')) vueFiles.push(p);
  }
};
walk(SRC);

const moduleExports = new Map();
for (const f of jsFiles) moduleExports.set(path.resolve(f), exportsOf(fs.readFileSync(f, 'utf8')));

console.log('=== ① .vue 的 import 是否都能对上导出 ===');
for (const f of vueFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s+\{([^}]+)\}\s+from\s+'([^']+)'/g)) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue; // 第三方/别名（如 @/）跳过
    const target = path.resolve(path.dirname(f), spec);
    let resolved = target;
    if (!fs.existsSync(resolved) && fs.existsSync(resolved + '.js')) resolved += '.js';
    if (!fs.existsSync(resolved) && fs.existsSync(path.join(resolved, 'index.js'))) resolved = path.join(resolved, 'index.js');
    if (!fs.existsSync(resolved)) {
      bad(`${path.relative(SRC, f)} 引入 ${spec}（文件不存在）`);
      continue;
    }
    if (!resolved.endsWith('.js')) continue;
    const ex = moduleExports.get(path.resolve(resolved)) || new Set();
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name && !ex.has(name)) bad(`${path.relative(SRC, f)} 引入 ${name}，但 ${path.relative(SRC, resolved)} 并未导出`);
    }
  }
}

console.log('=== ② 同名函数重复声明 ===');
for (const f of vueFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const names = [...src.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  for (const n of [...new Set(dup)]) bad(`${path.relative(SRC, f)} 重复声明 function ${n}（后者会静默覆盖前者）`);
}

console.log('=== ③ 页面注册与跳转目标 ===');
const pagesJson = JSON.parse(fs.readFileSync(path.join(SRC, 'pages.json'), 'utf8').replace(/\/\/.*$/gm, ''));
const registered = new Set(pagesJson.pages.map((p) => '/' + p.path));
for (const p of pagesJson.pages) {
  const vf = path.join(SRC, p.path + '.vue');
  if (!fs.existsSync(vf)) bad(`pages.json 注册了 ${p.path}，但页面文件不存在`);
}
for (const f of vueFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/url:\s*['"](\/pages\/[^'"?]+)/g)) {
    if (!registered.has(m[1])) bad(`${path.relative(SRC, f)} 跳转 ${m[1]}，但该页面未在 pages.json 注册`);
  }
}

console.log('=== ④ 页面调用 api/ 的函数是否都存在 ===');
const apiDir = path.join(SRC, 'api');
const apiNames = new Map();
for (const f of fs.readdirSync(apiDir)) {
  if (!f.endsWith('.js')) continue;
  apiNames.set(f.replace(/\.js$/, ''), exportsOf(fs.readFileSync(path.join(apiDir, f), 'utf8')));
}
for (const f of vueFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s+\{([^}]+)\}\s+from\s+'\.\.\/\.\.\/api\/([\w-]+)\.js'/g)) {
    const mod = m[2];
    const ex = apiNames.get(mod);
    if (!ex) {
      bad(`${path.relative(SRC, f)} 引用了不存在的 api 模块 ${mod}.js`);
      continue;
    }
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name && !ex.has(name)) bad(`${path.relative(SRC, f)} 从 api/${mod}.js 引入 ${name}，但未导出`);
    }
  }
}

console.log('=== ⑤ 模板里用到的变量 / 函数是否在 <script setup> 里声明 ===');
/* 这一类 bug 已经踩过两次：模板写了 smsCode / closeWechatLoginModal，脚本里根本没声明。
 * 打包不会报错，用户一点就白屏或报错，所以必须在构建前拦住。 */
const TPL_GLOBALS = new Set([
  'true', 'false', 'null', 'undefined', 'new', 'typeof', 'in', 'of', 'instanceof', 'void',
  'delete', 'this', 'if', 'else', 'return', 'await', 'async', 'function', 'try', 'catch',
  'Math', 'Date', 'JSON', 'String', 'Number', 'Boolean', 'Object', 'Array', 'Promise',
  'parseInt', 'parseFloat', 'isNaN', 'RegExp', 'Error', 'Map', 'Set', 'Symbol',
  'console', 'uni', 'wx', 'getApp', 'getCurrentPages',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'encodeURIComponent', 'decodeURIComponent',
]);

const root = (f) => path.relative(SRC, f).replace(/\\/g, '/');

for (const f of vueFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const tplMatch = src.match(/<template>([\s\S]*)<\/template>/);
  if (!tplMatch) continue;
  const tpl = tplMatch[1].replace(/<!--[\s\S]*?-->/g, ' ');

  // 声明面 = import 的名字 + 顶层 const/let/var/function
  const declared = new Set();
  for (const m of src.matchAll(/import\s+([\w${},\s*]+?)\s+from\s+/g)) {
    for (const raw of m[1].replace(/[{}*]/g, ' ').split(',')) {
      const n = raw.trim().split(/\s+as\s+/).pop().trim();
      if (n) declared.add(n);
    }
  }
  for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)/g)) declared.add(m[1]);
  // 解构声明：const { a, b: c } = useNavBar() / const [x] = arr
  for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const raw of m[1].split(',')) {
      const n = raw.trim().split(':').pop().trim().replace(/=.*$/, '').trim();
      if (/^[\w$]+$/.test(n)) declared.add(n);
    }
  }
  for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s*\[([^\]]*)\]/g)) {
    for (const raw of m[1].split(',')) {
      const n = raw.trim().replace(/=.*$/, '').trim();
      if (/^[\w$]+$/.test(n)) declared.add(n);
    }
  }
  for (const m of src.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([\w$]+)/g)) declared.add(m[1]);
  // defineProps({...}) 声明的 prop 名在模板里可直接使用
  for (const m of src.matchAll(/defineProps\s*\(\s*\{([\s\S]*?)\}\s*\)/g)) {
    for (const p of m[1].matchAll(/(?:^|\n|\{)\s*([\w$]+)\s*:/g)) declared.add(p[1]);
  }

  // v-for / 插槽作用域里临时引入的名字，视为已声明
  for (const m of tpl.matchAll(/v-for\s*=\s*"([^"]*)"/g)) {
    const left = m[1].split(/\s+(?:in|of)\s+/)[0];
    for (const t of left.matchAll(/[\w$]+/g)) declared.add(t[0]);
  }
  for (const m of tpl.matchAll(/(?:#[\w:.-]+|v-slot:[\w.-]*)\s*=\s*"([^"]*)"/g)) {
    for (const t of m[1].matchAll(/[\w$]+/g)) declared.add(t[0]);
  }

  const seen = new Set();
  const checkExpr = (expr, attrName) => {
    const cleaned = expr
      .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, ' ') // 去掉字符串字面量
      .replace(/\??\.\s*[\w$]+/g, ' ') // 去掉属性访问
      .replace(/([{,]\s*)[\w$]+\s*:/g, '$1'); // 去掉对象字面量的键（如 { height: pageHeightPx }）
    for (const t of cleaned.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const name = t[0];
      if (TPL_GLOBALS.has(name) || declared.has(name) || seen.has(name)) continue;
      seen.add(name);
      bad(`${root(f)} 模板属性 ${attrName} 用到 ${name}，但 <script setup> 里没有声明`);
    }
  };

  for (const m of tpl.matchAll(/(?:[:@#]|v-)[\w:.-]+\s*=\s*"([^"]*)"/g)) {
    const attr = m[0].split('=')[0].trim();
    if (/^#/.test(attr) || /^v-slot/.test(attr)) continue; // 作用域插槽的解构名已算作声明
    if (attr === 'v-for') {
      // v-for 只检查右侧被遍历的表达式，左侧是别名
      const right = m[1].split(/\s+(?:in|of)\s+/).slice(1).join(' ');
      if (right) checkExpr(right, 'v-for(数组)');
      continue;
    }
    checkExpr(m[1], attr);
  }
  for (const m of tpl.matchAll(/\{\{([^}]*)\}\}/g)) checkExpr(m[1], '{{ }}');
}

console.log('=== ⑥ 页面生命周期必须来自 @dcloudio/uni-app，不能来自 vue ===');
/* 2026-09-18：wallet.vue 写了 `import { ref, computed, onShow } from 'vue'`，
 * 打包直接失败：'onShow' is not exported by @dcloudio/uni-mp-vue。
 * 静态检查当时没发现，所以把这条规则固化下来。 */
const LIFECYCLE = [
  'onLoad', 'onShow', 'onReady', 'onHide', 'onUnload', 'onPullDownRefresh', 'onReachBottom',
  'onShareAppMessage', 'onShareTimeline', 'onPageScroll', 'onTabItemTap', 'onBackPress',
  'onResize', 'onNavigationBarButtonTap', 'onAddToFavorites',
];
for (const f of vueFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'vue'/g)) {
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim());
    for (const n of names) {
      if (LIFECYCLE.includes(n)) {
        bad(`${root(f)} 从 'vue' 引入 ${n}（页面生命周期必须来自 '@dcloudio/uni-app'，否则打包报 ${n} is not exported）`);
      }
    }
  }
}

console.log('=== ⑦ 注册的页面是否有入口（死胡同检查） ===');
/* 2026-09-18：pages/wallet/wallet 注册了、也能打包，但全项目没有一处跳转到它 ——
 * 用户永远打不开这个页面，等于白写。tabBar 页面本身就是入口，其余必须有跳转引用。 */
const allSrcFiles = [...vueFiles];
const walkJs = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(p);
    else if (e.name.endsWith('.js')) allSrcFiles.push(p);
  }
};
walkJs(SRC);
const tabPaths = new Set((pagesJson.tabBar?.list || []).map((t) => '/' + t.pagePath));
for (const p of pagesJson.pages) {
  const full = '/' + p.path;
  if (tabPaths.has(full)) continue;
  const referenced = allSrcFiles.some((f) => fs.readFileSync(f, 'utf8').includes(`url: '${full}`) || fs.readFileSync(f, 'utf8').includes(`url: \`${full}`));
  if (!referenced) bad(`${full} 已注册，但没有任何跳转指向它（用户打不开，属于死胡同）`);
}

console.log('');
console.log(problems === 0 ? '✅ 小程序接线检查全部通过' : `❌ 共 ${problems} 处问题`);
process.exit(problems ? 1 : 0);
