/**
 * 小程序隐私授权（《用户隐私保护指引》同意状态）
 *
 * ── 为什么需要这个文件 ───────────────────────────────────────────────────
 * 微信自 2023-09-15 起，调用"隐私接口"（录音、相册、摄像头、剪贴板、位置等）
 * 前必须先取得用户对《用户隐私保护指引》的同意。这套机制有两条生效路径：
 *
 *   ① 用户从未同意过 → 基础库在第一次调用隐私接口时**自动弹出官方弹窗**；
 *   ② 用户曾点过"拒绝"   → 之后**不再自动弹**，接口直接 fail。
 *
 * ②这条是坑：录音按钮点下去没有任何反应，控制台只有一句 `fail privacy permission is not authorized`。
 * 原代码把这种情况统一 toast 成「无法访问麦克风」—— 用户会去系统设置里翻麦克风权限，
 * 而真正要改的是小程序内的隐私授权，无处可改，等于死路。
 *
 * 所以这里主动调 `wx.requirePrivacyAuthorize`：
 *   · 已同意 → 静默返回 true；
 *   · 未同意 → 由基础库拉起官方弹窗（用户可当场同意）；
 *   · 曾拒绝/关闭弹窗 → fail，调用方据此给出**明确可操作**的提示（重新进入小程序或去"设置"）。
 *
 * ── 低版本怎么办 ─────────────────────────────────────────────────────────
 * `requirePrivacyAuthorize` 需要基础库 2.32.3+。低于该版本时接口不存在，
 * 此时微信**也不校验隐私授权**，直接按"可用"返回 true 才是正确行为；
 * 若这里返回 false，反倒会让老版本用户的语音功能无故消失。
 */

/** 隐私被拒时的错误码，调用方据此显示"去设置"而不是"没有麦克风" */
export const PRIVACY_DENIED = 'PRIVACY_DENIED';

/**
 * 确认隐私授权（必要时拉起官方弹窗）。
 * @returns {Promise<boolean>} true = 已同意，可以调用隐私接口
 */
export function ensurePrivacyAuthorize() {
  return new Promise((resolve) => {
    // #ifdef MP-WEIXIN
    try {
      const api = typeof wx !== 'undefined' ? wx : null;
      if (!api || typeof api.requirePrivacyAuthorize !== 'function') {
        resolve(true);
        return;
      }
      api.requirePrivacyAuthorize({
        success: () => resolve(true),
        fail: () => resolve(false),
      });
      return;
    } catch {
      // 接口本身异常（例如被容器屏蔽）不应把功能判死，按可用处理
      resolve(true);
      return;
    }
    // #endif
    // #ifndef MP-WEIXIN
    resolve(true);
    // #endif
  });
}

/**
 * 构造一个带错误码的隐私拒绝错误。
 *
 * 不用自定义 Error 子类：这个错误会穿过 async 边界与条件编译裁剪，
 * 普通 Error + `code` 字段在各端都稳，调用方只判断 `e.code` 即可。
 */
export function privacyDeniedError(action = '使用该功能') {
  const err = new Error(`需要先同意《隐私保护指引》才能${action}`);
  err.code = PRIVACY_DENIED;
  return err;
}
