/**
 * 钱包 / 缘值（Node 服务 /v1/wallet/*）
 *
 * 后端路由实测：
 *   GET /v1/wallet          余额、会员状态、各档位"对我会收多少"
 *   GET /v1/wallet/ledger   流水（含每笔的 balanceAfter，便于对账）
 *
 * 与"会员"的关系（业务方要求的分账）：
 *   钱包余额 = 缘值，只用于**转盘（每次 ¥1）与配对报告按次扣费**；
 *   会员费（¥29/79/299）买的是权益，**不进余额**。
 *   充值走「我的账户 → 缘值充值 → 微信在线支付」，付完由服务端自动入账（幂等）。
 */
import { get } from './request.js';

export function fetchWallet() {
  return get('/v1/wallet');
}

export function fetchWalletLedger(limit = 50) {
  return get('/v1/wallet/ledger', { limit });
}
