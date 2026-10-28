/**
 * 18+ 年龄门（小程序侧，2026-10-28 · 计划书 E.40）
 *
 * 对应官网 `js/adult-gate.js` 的同一套语义，只把 DOM 弹窗换成 `components/AdultGate.vue`：
 *   1. **未登录直接放行**：年龄门管的是付费与配对，未登录本来走不到那一步；
 *      硬弹窗只会打断登录流程（服务端仍会二次校验，绕不过）。
 *   2. **只收出生年份**：判 18+ 与人群口径（18–30）用年份就够，
 *      少收一个精确生日就少一份个人信息（最小必要原则）。
 *   3. **失败按"未通过"处理**：网络异常不放行，交给服务端 403 兜底。
 *
 * 后端：`GET /v1/profile/adult` → `{ok, birthYear, needAgree}`；`POST` 提交 `{birthYear}`，
 * 未满 18 返回 400 `E_UNDERAGE`（文案由服务端给，客户端不自己编）。
 */

import { get, post } from '../api/request.js';
import { isLoggedIn } from './auth.js';

/** 是否已过年龄门（未登录返回 false，调用方据登录态自行决定是否弹） */
export async function adultPassed() {
  try {
    const res = await get('/v1/profile/adult');
    return Boolean(res?.data?.ok);
  } catch {
    return false;
  }
}

/** 提交出生年份 + 承诺勾选 */
export async function submitAdult(birthYear) {
  const res = await post('/v1/profile/adult', { birthYear });
  return res?.data || res || {};
}

/**
 * 确保当前用户已过年龄门；未过则弹出组件收集，返回是否通过。
 * 与官网 `js/adult-gate.js::ensureAdult` 行为一致，页面只需一行：
 *   const ok = await ensureAdult(adultGate, '生成配对报告');
 *   if (!ok) return;
 *
 * @param {{value?: {ensure?: (action: string) => Promise<boolean>}}} gateRef 组件 ref
 * @param {string} action 动作名（弹窗标题里会显示，让用户知道"为什么现在问"）
 */
export async function ensureAdult(gateRef, action = '继续') {
  if (!isLoggedIn()) return true; // 未登录：交给登录流程处理，服务端仍会拦
  if (await adultPassed()) return true;

  const gate = gateRef?.value;
  // 页面忘了挂组件时**不放行**：宁可拦住一个已成年用户（他会看到错误提示），
  // 也不能让未成年用户直接进付费链路 —— 这类 bug 只有"严格失败"才不会静默。
  if (!gate?.ensure) return false;
  return Boolean(await gate.ensure(action));
}
