/**
 * 18+ 年龄门（2026-10-27 · 再改造实施书 P0-T0.2）
 *
 * 为什么必须有：产品口径是「18–30 岁成年人」，且已办网络文化经营许可证。
 * 没有年龄字段就没有口径，也没有任何合规证据链 —— 出事时无法自证"我们拦过"。
 *
 * ── 三道拦截（书里要求的三个入口）─────────────────────────────────────────
 *   1. 报告购买/生成  `requireAdult` 挂 `/v1/report/*` 的付费入口
 *   2. 转盘付费      `requireAdult` 挂 `/v1/wheel/spin`（免费转不拦，避免误伤体验）
 *   3. 候选池过滤    `adultRange()` 给候选查询加 `birthYear ∈ [当年-30, 当年-18]`
 *
 * ── 为什么用"出生年份"而不是出生日期 ──────────────────────────────────────
 * 只判 18+ 与人群口径（18–30）时，年份足够；少存一个精确生日，就少一份个人信息。
 * 这也是最小必要原则：能用年度表达的需求，不要收日期。
 */

import { getDB } from '../config/db.js';
import { ApiError } from '../lib/http.js';

/** 当前生效的《成年用户承诺》版本号；文案改版时递增，逼用户重新勾选 */
export const ADULT_AGREEMENT_VER = 'v1';

export function currentYearCN(now = new Date()) {
  return now.getFullYear();
}

/** 由出生年份算年龄（按年份差，不追月份 —— 宁可保守也不算大） */
export function ageFromBirthYear(birthYear, now = new Date()) {
  const y = Number(birthYear);
  if (!Number.isFinite(y) || y < 1900) return null;
  return currentYearCN(now) - y;
}

export function isAdult(birthYear, now = new Date()) {
  const age = ageFromBirthYear(birthYear, now);
  return age !== null && age >= 18;
}

/** 候选池年龄区间 [当年-30, 当年-18]（书里的人群口径） */
export function adultRange(now = new Date()) {
  const y = currentYearCN(now);
  return { min: y - 30, max: y - 18 };
}

/**
 * 读取用户的年龄门状态。
 * @returns {{ok:boolean, code?:string, message?:string, birthYear?:number, age?:number}}
 */
export async function adultStatus(uid) {
  const db = getDB();
  const user = await db.collection('users').findOne({ _id: uid }, { projection: { birthYear: 1, adultAgreedAt: 1, adultAgreementVer: 1 } });
  if (!user) return { ok: false, code: 'E_NO_USER', message: '账号不存在' };

  const birthYear = Number(user.birthYear) || null;
  if (!birthYear) {
    return { ok: false, code: 'E_NEED_BIRTHYEAR', message: '请先填写出生年份（本产品仅面向 18 岁以上成年人）' };
  }
  const age = ageFromBirthYear(birthYear);
  if (age === null) return { ok: false, code: 'E_BAD_BIRTHYEAR', message: '出生年份无效' };
  if (age < 18) {
    return { ok: false, code: 'E_UNDERAGE', message: '本产品仅面向 18 岁以上成年人，暂无法提供付费服务', age, birthYear };
  }
  if (!user.adultAgreedAt || user.adultAgreementVer !== ADULT_AGREEMENT_VER) {
    return { ok: false, code: 'E_NEED_ADULT_AGREE', message: '请先勾选《成年用户承诺》', birthYear, age };
  }
  return { ok: true, birthYear, age };
}

/**
 * Express 中间件：未通过年龄门则 403。
 * 用 403 而不是 400 —— 这是"策略拒绝"，不是"参数错误"，前端据此弹年龄门而不是报错。
 */
export async function requireAdult(req, res, next) {
  try {
    const st = await adultStatus(req.uid);
    if (!st.ok) {
      return res.status(403).json({
        code: st.code,
        error: st.message,
        needAdult: true,
        agreementVer: ADULT_AGREEMENT_VER,
      });
    }
    req.adult = { birthYear: st.birthYear, age: st.age };
    return next();
  } catch (err) {
    console.error('[adult] 校验异常：', err?.message || err);
    throw new ApiError(500, '年龄校验失败，请稍后重试', 'E_ADULT_CHECK');
  }
}

/** 写入出生年份 + 勾选协议（幂等） */
export async function agreeAdult(uid, { birthYear }) {
  const y = Number(birthYear);
  const now = new Date();
  if (!Number.isFinite(y) || y < 1900 || y > now.getFullYear()) {
    return { ok: false, code: 'E_BAD_BIRTHYEAR', message: '请选择有效的出生年份' };
  }
  if (currentYearCN(now) - y < 18) {
    return { ok: false, code: 'E_UNDERAGE', message: '本产品仅面向 18 岁以上成年人' };
  }
  /* E.93 修复：upsert:false 在 users 文档不存在时（只注册、还没 PATCH 过资料的新号）
   * 会**静默无效**——POST /adult 返回 ok:true 但 birthYear 根本没落库，
   * 之后所有 requireAdult 入口（付费转盘/报告）误报 E_NEED_BIRTHYEAR
   * （2026-11-12 转盘线上实测抓到）。改 upsert:true，_id=uid 字符串与
   * profile PATCH 的键型一致。 */
  await getDB()
    .collection('users')
    .updateOne(
      { _id: uid },
      { $set: { birthYear: y, adultAgreedAt: now, adultAgreementVer: ADULT_AGREEMENT_VER, updatedAt: now } },
      { upsert: true },
    );
  return { ok: true, birthYear: y, age: currentYearCN(now) - y, agreementVer: ADULT_AGREEMENT_VER };
}
