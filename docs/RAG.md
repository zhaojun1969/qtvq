# 避坑 RAG 知识检索

Q问 `/api/chat` 在回答前会从 **50+ 避坑案例** 中检索最相关内容，注入 System Prompt，使 AI 回答更贴「避坑大全」真实案例。

## 架构

```
用户提问
  → Embedding（@cf/qwen/qwen3-embedding-0.6b）
  → 与 rag-index.json 余弦相似度 Top 4
  → 拼入 System Prompt
  → GLM / Qwen / Llama 生成直线方案
```

向量索引在**构建时**预生成（非每次请求全量 embed 案例），仅对用户问题做 1 次 embedding。

## 构建索引

```powershell
# 需要 cf.env 中 CLOUDFLARE_API_TOKEN
npm run build:rag
```

输出：`functions/data/rag-index.json`（约 58 条：50 案例 + 5 热点 + 3 专题）

**更新 `js/data.js` 后需重新 `build:rag` 并 deploy API。**

## 部署

```powershell
npm run build:rag
npm run deploy:api-only
```

`/api/health` 字段 `ragReady: true` 表示索引已加载。

## 响应字段

`/api/chat` 返回：

```json
{
  "reply": "...",
  "rag": {
    "ready": true,
    "method": "vector",
    "hits": [{ "id": 2, "title": "备胎陷阱", "category": "暧昧" }]
  }
}
```

| method | 含义 |
|--------|------|
| `vector` | 向量检索命中 |
| `keyword` | 向量不可用时的关键词兜底 |
| `none` | 未命中（使用摘要兜底） |

## 模型优先级（chat.js）

1. `@cf/zai-org/glm-4.7-flash` — 中文对话首选
2. `@cf/qwen/qwen3-30b-a3b-fp8` — 中文质量备选
3. `@cf/meta/llama-3.1-8b-instruct` — 兜底

## 故障排查

| 现象 | 处理 |
|------|------|
| `ragReady: false` | 运行 `npm run build:rag` 后重新 deploy |
| `method: keyword` | Embedding 调用失败，检查 Workers AI 额度 |
| 回答仍泛化 | 查看 `rag.hits` 是否命中正确案例 |
