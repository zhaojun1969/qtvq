/**
 * 同步各端发布记录到 Pages 侧：`server/app-releases.json` → `functions/data/app-releases.generated.js`
 *
 * 为什么不是"两边各写一份"：发布记录一旦分叉，端侧拿到的版本信息就会与静态站、
 * 与 Node 服务不一致 —— 这类"同一份事实存在两处、各自演进"的问题本项目已踩过多次
 * （`ADMIN_KEY` 本地/服务器分叉、`LLM_PROVIDER` 两处不一致）。
 * 这里让 `server/app-releases.json` 作为**唯一源**，Pages 侧只放生成副本。
 *
 * Pages（Cloudflare Functions）无法在运行时读服务器上的文件，所以只能是"生成一份带标记的副本"，
 * 并由 `tools/scripts/check-app-bootstrap.mjs` 校验两边一致（不一致就报错）。
 *
 * 用法：node tools/scripts/write-app-releases.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'app-releases.json');
const DEST = path.join(ROOT, 'functions', 'data', 'app-releases.generated.js');

if (!fs.existsSync(SRC)) {
  console.error(`ERROR: 找不到 ${path.relative(ROOT, SRC)}`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(SRC, 'utf8'));
} catch (err) {
  console.error(`ERROR: ${path.relative(ROOT, SRC)} 不是合法 JSON：${err.message}`);
  console.error('  提示：JSON 不能带注释（说明文字放在 "_说明" 字段里）。');
  process.exit(1);
}

const notes = parsed._说明 || [];
delete parsed._说明;
/*
 * 所有 `_` 开头的键都是**给人看的说明块**（`_说明` / `_未发布渠道`），不是渠道。
 * 原来的写法只删 `_说明`，加第二个说明数组时它会直接变成一个"渠道"，
 * 被写进 APP_RELEASES_GENERATED 与 release/version.json —— 那种脏数据在端侧
 * 表现为"多了一个不存在的渠道"，很难查。所以按前缀一律剔除。
 */
for (const key of Object.keys(parsed)) {
  if (key.startsWith('_')) {
    delete parsed[key];
  }
}

const generatedAt = new Date().toISOString();

/** 生成一份"带标记的只读副本"，避免两边各自维护而分叉 */
function renderBody(target) {
  return `/**
 * ⚠️ 本文件由 tools/scripts/write-app-releases.mjs 生成，请勿手改。
 * 唯一数据源：app-releases.json（仓库根）
 * 用途：${target}
 * 生成时间：${generatedAt}
 *
 * ${notes.join('\n * ')}
 */

export const GENERATED_AT = ${JSON.stringify(generatedAt)};

export const APP_RELEASES_GENERATED = ${JSON.stringify(parsed, null, 2)};
`;
}

/** 需要同一份发布记录的两侧（部署包只含 server/，所以 Node 必须有自己的副本） */
const TARGETS = [
  [DEST, 'Cloudflare Pages（`/api/app/bootstrap`）'],
  [
    path.join(ROOT, 'server', 'src', 'data', 'app-releases.generated.js'),
    '自建 Node（迁移后的 `/api/app/bootstrap`）',
  ],
];

for (const [dest, target] of TARGETS) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, renderBody(target), 'utf8');
  console.log(`>> 已同步发布记录 → ${path.relative(ROOT, dest)}  （${target}）`);
}

/*
 * RAG 状态副本（给 Node 用）。
 *
 * 为什么**只生成条目数、不复制向量**：`functions/lib/rag.js` 的
 * `isRagReady()` 语义仅仅是「索引里有没有条目」，Node 侧要如实报告这个能力，
 * 只需要知道条目数；那 58 条向量只在真正做检索时才有用，而检索路径这次没有迁。
 * 复制 1.2MB 派生数据会引入"向量副本过期"这类新问题，收益为零。
 * 若将来检索路径也要迁到 Node，再把这里改成生成完整索引。
 */
const RAG_SRC = path.join(ROOT, 'functions', 'data', 'rag-index.json');
const RAG_DEST = path.join(ROOT, 'server', 'src', 'data', 'rag-status.generated.js');
if (fs.existsSync(RAG_SRC)) {
  let ragItems = 0;
  try {
    ragItems = JSON.parse(fs.readFileSync(RAG_SRC, 'utf8'))?.items?.length || 0;
  } catch (err) {
    console.error(`ERROR: ${path.relative(ROOT, RAG_SRC)} 不是合法 JSON：${err.message}`);
    process.exit(1);
  }
  const ragBody = `/**
 * ⚠️ 本文件由 tools/scripts/write-app-releases.mjs 生成，请勿手改。
 * 唯一数据源：functions/data/rag-index.json
 * 生成时间：${generatedAt}
 *
 * **这里刻意不放向量**：Node 侧只负责如实报告「RAG 是否可用」（= 索引有无条目），
 * 不承担检索。复制完整索引（1.2MB 含向量）会引入"副本过期"这类新问题而收益为零。
 * 若将来检索路径也迁到 Node，再改成生成完整索引。
 */

export const RAG_GENERATED_AT = ${JSON.stringify(generatedAt)};

export const RAG_ITEM_COUNT = ${ragItems};

/** 与 Pages 侧 \`functions/lib/rag.js\` 的 \`isRagReady()\` 同口径 */
export function isRagReady() {
  return RAG_ITEM_COUNT > 0;
}
`;
  fs.mkdirSync(path.dirname(RAG_DEST), { recursive: true });
  fs.writeFileSync(RAG_DEST, ragBody, 'utf8');
  console.log(`>> 已同步 RAG 状态 → ${path.relative(ROOT, RAG_DEST)}  （条目数 ${ragItems}）`);
} else {
  console.log(`⚠️ 未找到 ${path.relative(ROOT, RAG_SRC)}，跳过 RAG 状态副本`);
}

const channels = Object.keys(parsed);
console.log(`   已发布渠道（${channels.length}）: ${channels.join(', ')}`);
console.log(`   其余渠道按出厂基线 1.0.0「已最新」处理`);
