/**
 * 无依赖的本地模块图校验：确保每个本地 import 的具名绑定
 * 在目标文件里确实被导出。`node --check` 只查语法，查不出这类拼写错误。
 *
 * 用法：node scripts/check-imports.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['src', 'scripts'];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...walk(full));
    } else if (/\.(m?js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function exportsOf(code) {
  const names = new Set();
  const patterns = [
    /export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g,
    /export\s*\{([^}]*)\}/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(code))) {
      if (re.source.includes('\\{')) {
        for (const part of m[1].split(',')) {
          const seg = part.trim();
          if (!seg) continue;
          const as = seg.split(/\s+as\s+/);
          names.add((as[1] || as[0]).trim());
        }
      } else {
        names.add(m[1]);
      }
    }
  }
  if (/export\s+default\b/.test(code)) names.add('default');
  if (/export\s+\*/.test(code)) names.add('*');
  return names;
}

function importsOf(code) {
  const out = [];
  const re = /import\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code))) {
    const clause = m[1].trim();
    const spec = m[2];
    const names = [];
    let isDefault = false;
    let isNamespace = false;

    const brace = clause.match(/\{([\s\S]*)\}/);
    if (brace) {
      for (const part of brace[1].split(',')) {
        const seg = part.trim();
        if (!seg) continue;
        names.push(seg.split(/\s+as\s+/)[0].trim());
      }
    }
    const withoutBrace = clause.replace(/\{[\s\S]*\}/, '').replace(/,\s*$/, '').trim();
    if (withoutBrace.startsWith('*')) isNamespace = true;
    else if (withoutBrace) isDefault = true;

    out.push({ spec, names, isDefault, isNamespace });
  }
  return out;
}

function resolveLocal(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return `MISSING:${base}`;
}

const files = SCAN_DIRS.flatMap((d) => {
  const p = path.join(ROOT, d);
  return fs.existsSync(p) ? walk(p) : [];
});

const problems = [];
for (const file of files) {
  const code = fs.readFileSync(file, 'utf8');
  for (const imp of importsOf(code)) {
    const target = resolveLocal(file, imp.spec);
    if (!target) continue; // 外部依赖，跳过
    const rel = path.relative(ROOT, file);
    if (target.startsWith('MISSING:')) {
      problems.push(`${rel}: 找不到模块 '${imp.spec}'`);
      continue;
    }
    const targetExports = exportsOf(fs.readFileSync(target, 'utf8'));
    if (targetExports.has('*')) continue; // 有 re-export，跳过严格校验
    for (const name of imp.names) {
      if (!targetExports.has(name)) {
        problems.push(`${rel}: 从 '${imp.spec}' 导入了未导出的 '${name}'`);
      }
    }
    if (imp.isDefault && !targetExports.has('default')) {
      problems.push(`${rel}: '${imp.spec}' 没有 default 导出`);
    }
  }
}

console.log(`[check-imports] 扫描 ${files.length} 个文件`);

// 额外检查：constants 里的档位枚举必须覆盖所有被引用的 tier 字面量
const constants = fs.readFileSync(path.join(ROOT, 'src/constants.js'), 'utf8');
for (const tier of ['basic', 'advanced', 'deep', 'soul']) {
  if (!constants.includes(`${tier}:`)) problems.push(`src/constants.js: 缺少档位 '${tier}'`);
}

if (problems.length) {
  console.error(`[check-imports] ❌ ${problems.length} 个问题：`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('[check-imports] ✅ 本地模块图与档位枚举均一致');
