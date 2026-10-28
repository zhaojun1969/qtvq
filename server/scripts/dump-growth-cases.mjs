/**
 * 导出增长内容矩阵所需的案例素材（实施书 P3-T3.1）
 *
 * 只读，不改库。输出一段 JSON 到 stdout，由本地脚本
 * `tools/scripts/gen-growth-content.mjs` 拿去生成 20 条内容三件套。
 *
 * 为什么不在本地直连生产 Mongo：本地没有白名单，生产库只允许本机访问。
 * 于是让脚本在服务器上跑、把结果带回来 —— 这是唯一不开口子的做法。
 *
 * 跑法：cd /opt/qtvq/server && node --env-file=.env scripts/dump-growth-cases.mjs > /tmp/cases.json
 */
import process from 'node:process';

const LIMIT = Number(process.env.LIMIT || 20);

function pickStr(v, max = 400) {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

async function main() {
  const { connectDB, getDB } = await import('../src/config/db.js');
  // 直连库的脚本必须显式 connectDB：app.js 才会自动连接，单跑脚本不会
  await connectDB();
  const db = getDB();
  const col = db.collection('pitfalls');

  const total = await col.countDocuments();
  // 优先挑"有正文可引用"的案例：内容矩阵要能讲出细节，只有标题的条目写不成脚本。
  const docs = await col
    .find(
      {},
      {
        projection: {
          title: 1,
          category: 1,
          summary: 1,
          content: 1,
          advice: 1,
          tags: 1,
          signals: 1,
          severity: 1,
          // 注意：projection 只能全包含或全排除，`vector: 0` 混在包含式里会直接报错
        },
      },
    )
    .sort({ _id: 1 })
    .limit(200)
    .toArray();

  const items = docs
    .map((d) => ({
      id: String(d._id),
      title: pickStr(d.title, 120),
      category: pickStr(d.category, 40),
      summary: pickStr(d.summary || d.content, 320),
      advice: Array.isArray(d.advice) ? d.advice.map((a) => pickStr(a, 160)).filter(Boolean).slice(0, 4) : [],
      tags: Array.isArray(d.tags) ? d.tags.map((t) => pickStr(t, 24)).filter(Boolean).slice(0, 6) : [],
      signals: Array.isArray(d.signals) ? d.signals.map((s) => pickStr(s, 60)).filter(Boolean).slice(0, 6) : [],
      severity: d.severity ?? null,
    }))
    // 只要求标题：pitfalls 集合当前只有 title/category 两个业务字段（50 条），
    // 正文是生成时由 RAG 拼的。要求"有正文"会把 50 条全过滤掉 —— 之前的过滤器就是这么错的。
    .filter((x) => x.title)
    .slice(0, LIMIT);

  process.stdout.write(
    JSON.stringify(
      {
        dumpedAt: new Date().toISOString(),
        total,
        used: items.length,
        // 一条样例（字段名 + 截断内容）：字段对不上时靠它定位，不然只能靠猜
        sample: docs[0] ? { keys: Object.keys(docs[0]), doc: JSON.stringify(docs[0]).slice(0, 900) } : null,
        items,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('导出失败：', err?.message || err);
  process.exit(1);
});
