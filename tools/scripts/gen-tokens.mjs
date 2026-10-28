#!/usr/bin/env node
/**
 * 设计令牌生成器（Phase 1 · packages/tokens）
 *
 * 从 `packages/tokens/src/index.js` 这个唯一来源，生成两端的产物：
 *
 *   ① `css/tokens.css`        —— 官网用 CSS 自定义属性（`:root`）
 *   ② `apps/qtvq-uni/src/uni.scss` —— 小程序用 SCSS 变量（uni-app 自动注入每个 SFC）
 *
 * 同时把官网 `css/styles.css` 里那段既有的 `:root { ... }` 用守卫标记包起来并重写成生成内容，
 * 保证"变量的定义只有一处"，而不是网页一份、小程序一份、styles.css 再一份。
 *
 * 用法
 * ----
 *   node tools/scripts/gen-tokens.mjs            # 生成/覆盖产物
 *   node tools/scripts/gen-tokens.mjs --check    # 只校验是否与源一致（CI 用，不一致退码 1）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CHECK = process.argv.includes('--check');

const TOKENS = await import(
  new URL('../../packages/tokens/src/index.js', import.meta.url).href
);

const { COLOR, RADIUS, SPACE, FONT_STACK, GRADIENT, SHADOW } = TOKENS;

/* ------------------------------------------------------------------ 官网产物 */

function buildCssTokens() {
  const lines = [];
  lines.push('/* 由 tools/scripts/gen-tokens.mjs 从 packages/tokens 生成，请勿手改 */');
  lines.push(':root {');
  for (const [k, v] of Object.entries(COLOR)) {
    lines.push(`  --${kebab(k)}: ${v};`);
  }
  // 官网既有 `--radius` 与 `--gradient` / `--shadow` / `--font` 必须保留原名，
  // 因为 styles.css 里分别引用了 15 / 9 / 2 / 1 次
  lines.push(`  --radius: ${RADIUS.lg}px;`);
  for (const [k, v] of Object.entries(RADIUS)) {
    if (k === 'lg') continue;
    lines.push(`  --radius-${k}: ${v}px;`);
  }
  for (const [k, v] of Object.entries(SPACE)) {
    lines.push(`  --space-${k}: ${v}px;`);
  }
  lines.push(`  --gradient: ${GRADIENT};`);
  lines.push(`  --shadow: ${SHADOW};`);
  lines.push(`  --font: ${FONT_STACK};`);
  lines.push('}');
  return lines.join('\n') + '\n';
}

/* ---------------------------------------------------------------- 小程序产物 */

function buildUniScss() {
  const lines = [];
  lines.push('// 由 tools/scripts/gen-tokens.mjs 从 packages/tokens 生成，请勿手改');
  lines.push('// uni-app 会自动把本文件注入每个 SFC 的 <style lang="scss">，因此变量可直接使用');
  lines.push('');
  lines.push('// ---- 颜色 ----');
  for (const [k, v] of Object.entries(COLOR)) {
    lines.push(`$color-${kebab(k)}: ${v};`);
  }
  lines.push('');
  lines.push('// ---- 圆角（rpx，750 设计稿）----');
  for (const [k, v] of Object.entries(RADIUS)) {
    lines.push(`$radius-${kebab(k)}: ${v * 2}rpx;`);
  }
  lines.push('');
  lines.push('// ---- 间距（rpx）----');
  for (const [k, v] of Object.entries(SPACE)) {
    lines.push(`$space-${kebab(k)}: ${v * 2}rpx;`);
  }
  lines.push('');
  lines.push('// ---- 字体与视觉 ----');
  lines.push(`$font-stack: ${FONT_STACK};`);
  lines.push(`$gradient-brand: ${GRADIENT};`);
  lines.push(`$shadow-card: ${SHADOW};`);
  return lines.join('\n') + '\n';
}

function kebab(s) {
  return s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}

/* ------------------------------------------------------- styles.css 的 :root */

const START = '/* @tokens:start —— 由 tools/scripts/gen-tokens.mjs 生成，勿手改 */';
const END = '/* @tokens:end */';

function rewriteStylesRoot(css) {
  if (css.includes(START) && css.includes(END)) {
    const i = css.indexOf(START);
    const j = css.indexOf(END) + END.length;
    const body = buildCssTokens();
    return css.slice(0, i) + START + '\n' + body + END + css.slice(j);
  }
  // 首次运行：找到第一个 `:root { ... }` 块，用标记包起来
  const m = /:root\s*\{[^}]*\}/.exec(css);
  if (!m) throw new Error('css/styles.css 里没有找到 :root 块，无法建立令牌守卫');
  const body = buildCssTokens();
  return css.slice(0, m.index) + START + '\n' + body + END + css.slice(m.index + m[0].length);
}

/* --------------------------------------------------------------------- 执行 */

/*
 * 只保留两端**实际会被消费**的产物，不留"生成出来但没人读"的孤儿文件：
 *   · 官网：变量直接写进 css/styles.css 的 :root（该文件本来就被 11 个页面引用）
 *   · 小程序：写入 src/uni.scss（uni-app 自动注入每个 SFC）
 */
const targets = [
  {
    file: path.join(ROOT, 'apps/qtvq-uni/src/uni.scss'),
    build: buildUniScss,
    label: '小程序 SCSS 变量',
  },
];

let drifted = 0;

for (const t of targets) {
  const want = t.build();
  const exists = fs.existsSync(t.file);
  const have = exists ? fs.readFileSync(t.file, 'utf8') : '';
  if (have === want) {
    console.log(`  ✓ ${t.label}：${path.relative(ROOT, t.file)} 已是最新`);
    continue;
  }
  if (CHECK) {
    drifted += 1;
    console.log(`  ✗ ${t.label}：${path.relative(ROOT, t.file)} 与 packages/tokens 不一致`);
    continue;
  }
  fs.mkdirSync(path.dirname(t.file), { recursive: true });
  fs.writeFileSync(t.file, want, 'utf8');
  console.log(`  ✎ ${t.label}：已写入 ${path.relative(ROOT, t.file)}`);
}

// styles.css 的 :root 也要跟着源走
const stylesFile = path.join(ROOT, 'css/styles.css');
const stylesNow = fs.readFileSync(stylesFile, 'utf8');
const stylesWant = rewriteStylesRoot(stylesNow);
if (stylesNow !== stylesWant) {
  if (CHECK) {
    drifted += 1;
    console.log('  ✗ 官网 css/styles.css：`:root` 块与 packages/tokens 不一致');
  } else {
    fs.writeFileSync(stylesFile, stylesWant, 'utf8');
    console.log('  ✎ 官网 css/styles.css：`:root` 块已按令牌重写');
  }
} else {
  console.log('  ✓ 官网 css/styles.css：`:root` 块与源一致');
}

if (CHECK && drifted > 0) {
  console.error(`\n[gen-tokens] 令牌漂移 ${drifted} 处。运行 node tools/scripts/gen-tokens.mjs 重新生成。`);
  process.exit(1);
}
console.log('\n[gen-tokens] 完成');
