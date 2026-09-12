/**
 * 把现有站点的 50+ 条避坑案例导入 MongoDB，并重新生成 1024 维向量。
 *
 * 数据源：../../js/data.js（PITFALLS = PITFALLS_BASE + EXTRA_PITFALLS）
 * 用法：cd server && npm run import:pitfalls
 *
 * 注意：向量必须用**当前配置的 provider** 重新生成。现网的
 * functions/data/rag-index.json 是 Cloudflare qwen3-embedding-0.6b 产出的，
 * 若直接复用，一旦换了 provider 就会跨模型比较，相似度不可信。
 * （两者维度都是 1024，所以「维度对得上」不等于「空间一致」，务必重跑本脚本。）
 */
import { connectDB, closeDB, getDB } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { embedMany } from '../src/services/embed.js';
import { PITFALLS, CATEGORIES } from '../../js/data.js';

function buildText(p) {
  return [p.category, p.title, p.lesson, p.steps].filter(Boolean).join(' ');
}

async function main() {
  console.log(`[import] 源案例数：${PITFALLS.length}，分类：${CATEGORIES.join('/')}`);
  console.log(`[import] Embedding provider=${env.embedProvider} dims=${env.embedDims}`);

  const db = await connectDB();
  const col = db.collection('pitfalls');

  const texts = PITFALLS.map(buildText);
  const vectors = await embedMany(texts);
  const ok = vectors.filter(Boolean).length;
  console.log(`[import] 向量生成完成：${ok}/${texts.length}`);

  if (!ok) {
    console.error('[import] 没有任何向量生成成功。请检查 DASHSCOPE_API_KEY（或所选 provider 的密钥）后重跑。');
    console.error('[import] 已中止，未写入数据库 —— 避免写入无向量的半成品数据。');
    await closeDB();
    process.exit(1);
  }

  const ops = PITFALLS.map((p, i) => ({
    updateOne: {
      filter: { id: p.id },
      update: {
        $set: {
          id: p.id,
          category: p.category,
          title: p.title,
          lesson: p.lesson || '',
          steps: p.steps || '',
          cost: p.cost || null,
          helped: p.helped || 0,
          quiz: p.quiz || null,
          vector: vectors[i] || null,
          vectorDims: vectors[i] ? vectors[i].length : 0,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      upsert: true,
    },
  }));

  const result = await col.bulkWrite(ops, { ordered: false });
  const total = await col.countDocuments();
  console.log(`[import] 写入完成：upserted=${result.upsertedCount} modified=${result.modifiedCount} 库内合计=${total}`);

  const missing = await col.countDocuments({ vector: null });
  if (missing) console.warn(`[import] ⚠️  有 ${missing} 条没有向量，检索时会走关键词兜底`);

  await closeDB();
}

main().catch(async (err) => {
  console.error('[import] 失败:', err);
  await closeDB().catch(() => {});
  process.exit(1);
});
