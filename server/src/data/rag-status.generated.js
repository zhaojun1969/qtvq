/**
 * ⚠️ 本文件由 tools/scripts/write-app-releases.mjs 生成，请勿手改。
 * 唯一数据源：functions/data/rag-index.json
 * 生成时间：2026-10-11T07:43:34.272Z
 *
 * **这里刻意不放向量**：Node 侧只负责如实报告「RAG 是否可用」（= 索引有无条目），
 * 不承担检索。复制完整索引（1.2MB 含向量）会引入"副本过期"这类新问题而收益为零。
 * 若将来检索路径也迁到 Node，再改成生成完整索引。
 */

export const RAG_GENERATED_AT = "2026-10-11T07:43:34.272Z";

export const RAG_ITEM_COUNT = 58;

/** 与 Pages 侧 `functions/lib/rag.js` 的 `isRagReady()` 同口径 */
export function isRagReady() {
  return RAG_ITEM_COUNT > 0;
}
