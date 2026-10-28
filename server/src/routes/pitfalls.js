/**
 * 避坑内容（公开，无需登录）
 *
 * `GET /v1/pitfalls?category=&keyword=&page=&pageSize=`
 *
 * 为什么要有这个路由：原来**没有**任何 HTTP 接口暴露避坑内容 —— 网页端读的是本地静态数据
 * （`js/data.js`），MongoDB 的 `pitfalls` 集合只被报告生成的向量检索用到。
 * 于是"没有本地静态数据"的端（鸿蒙 App、未来的其它 App）拿不到内容，
 * 只能各自抄一份，必然漂移。2026-09-22 写鸿蒙工程时正是踩到这一点
 * （我凭记忆写了 `/v1/profile/pitfalls`，那个路由不存在）。
 *
 * 内容是公开的科普案例，不含用户数据；投影里**不含向量**（1024 维，既无用又占带宽）。
 */
import { Router } from 'express';
import { ok, wrap } from '../lib/http.js';
import { listPitfalls } from '../services/pitfalls.js';

const router = Router();

router.get(
  '/',
  wrap(async (req, res) => {
    const data = await listPitfalls({
      category: String(req.query.category || ''),
      keyword: String(req.query.keyword || ''),
      page: Number(req.query.page) || 1,
      pageSize: Number(req.query.pageSize) || 20,
    });
    return ok(res, data);
  }),
);

export default router;
