#!/usr/bin/env node
/**
 * 三端派生自共享层（L0）校验
 *
 * 为什么需要：项目历史上两次真实事故都源于"同一份规则各端各写一份"——
 *   ① 举报原因白名单：网页 7 项、小程序 4 项 → 小程序举报**必然 400**（用户点了没反应）；
 *   ② 收款渠道漏 `autoCredit` → 用户以为付了就会自动到账。
 * 这两次都是靠"事后加检查器比对字符串"兜住的 —— 那是**发现**不一致，不是**消除**不一致。
 *
 * 现在的结构目标是：常量只在 `packages/shared` 定义一次，三端 import 同一份。
 * 本检查器把这句"应该"变成机器可校验的断言：
 *
 *   1. 这些常量**只允许**在 packages/shared 里定义（出现在别处即判红）；
 *   2. 三端必须真的 import 它（漏一端也判红 —— 漏了就等于那一端在自己维护副本）；
 *   3. 官方/小程序端允许存在的"平台差异"（如收款码图片路径）不算违规。
 *
 * 用法：
 *   node tools/scripts/check-shared-derivation.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

/**
 * 必须单一定义、且「哪几端必须导入」逐项声明的常量。
 *
 * 为什么按常量分别声明而不是一律要求三端：`STATIC_PAY_CHANNELS`（静态收款码渠道）
 * 只在**前端**用到 —— 服务端不处理静态收款码（那是 Pages / 前端的事）。
 * 一律要求三端会得到一条永远无法满足的断言，最后只能被注释掉，等于没有约束。
 */
const SHARED_CONSTANTS = {
  REPORT_REASONS: { ends: ['官网', '小程序', '服务端'] },
  STATIC_PAY_CHANNELS: { ends: ['官网', '小程序'] },
};
const CONSTANT_NAMES = Object.keys(SHARED_CONSTANTS);

/** 需要检查的三端：名字 → 该端的源码文件（递归扫描） */
const ENDS = {
  官网: ['js'],
  小程序: ['apps/qtvq-uni/src'],
  服务端: ['server/src'],
};

const SHARED_DIR = path.join(ROOT, 'packages', 'shared');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      walk(p, out);
    } else if (/\.(js|mjs|vue)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/** 找出某文件里对这些常量的「本地定义」（而非 import） */
function localDefinitions(file, names) {
  const src = fs.readFileSync(file, 'utf8');
  const hits = [];
  for (const n of names) {
    const re = new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${n}\\s*=`, 'm');
    if (re.test(src)) hits.push(n);
  }
  return hits;
}

const problems = [];

/* ① 共享层之外不允许定义 */
for (const [endName, dirs] of Object.entries(ENDS)) {
  for (const d of dirs) {
    for (const file of walk(path.join(ROOT, d))) {
      if (file.startsWith(SHARED_DIR)) continue;
      const dup = localDefinitions(file, CONSTANT_NAMES);
      if (dup.length) {
        problems.push(
          `${path.relative(ROOT, file)}: ${endName}端自己定义了 ${dup.join(', ')} —— 必须改为从 packages/shared 导入`,
        );
      }
    }
  }
}

/* ② 声明的端必须真的从 shared 引入 */
const IMPORT_FORMS = [
  // import { A, B as C } from '…shared…'
  (c) => new RegExp(`import\\s*\\{[^}]*\\b${c}\\b[^}]*\\}\\s*from\\s*['"][^'"]*shared`),
  // export { X as Y, … } from '…shared…'（官网 `pay-qr.js` 就是这种再导出写法）
  (c) => new RegExp(`export\\s*\\{[^}]*\\b${c}\\b[^}]*\\}\\s*from\\s*['"][^'"]*shared`),
];

for (const [constant, rule] of Object.entries(SHARED_CONSTANTS)) {
  for (const endName of rule.ends) {
    const files = (ENDS[endName] || []).flatMap((d) => walk(path.join(ROOT, d)));
    const importedBy = files.filter((f) => {
      const src = fs.readFileSync(f, 'utf8');
      return IMPORT_FORMS.some((build) => build(constant).test(src));
    });
    if (importedBy.length === 0) {
      problems.push(`${endName}端没有任何文件从 shared 引入 ${constant} —— 该端可能在使用自己的副本`);
    }
  }
}

/* ③ 共享层自身必须确实定义了这些常量 */
{
  const sharedEntry = path.join(SHARED_DIR, 'src', 'index.js');
  if (!fs.existsSync(sharedEntry)) {
    problems.push('缺少 packages/shared/src/index.js');
  } else {
    const src = fs.readFileSync(sharedEntry, 'utf8');
    for (const c of CONSTANT_NAMES) {
      if (!new RegExp(`^export\\s+const\\s+${c}\\s*=`, 'm').test(src)) {
        problems.push(`packages/shared/src/index.js 没有导出 ${c}`);
      }
    }
  }
}

if (problems.length === 0) {
  console.log(
    `[check-shared-derivation] ✅ ${CONSTANT_NAMES.map((c) => `${c}→${SHARED_CONSTANTS[c].ends.join('/')}`).join('、')} 均只在 shared 定义且各端已导入`,
  );
  process.exit(0);
}

console.error(`[check-shared-derivation] ❌ ${problems.length} 处不符合单一来源要求：`);
for (const p of problems) console.error('  ' + p);
console.error('\n修法：删掉该端的本地定义，改为 import { … } from 共享层（小程序用 @qtvq/shared alias）。');
process.exit(1);
