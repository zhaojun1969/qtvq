/**
 * 18+ 年龄门（H5，2026-10-27 · 再改造实施书 P0-T0.2）
 *
 * 用法（在需要付费的入口前调用）：
 *   import { ensureAdult } from './adult-gate.js';
 *   const ok = await ensureAdult({ action: '生成配对报告' });
 *   if (!ok) return;                       // 用户没填/未满 18，直接中止
 *
 * ── 三个刻意的行为 ────────────────────────────────────────────────────────
 * 1. **未登录时直接放行**：年龄门管的是"付费"，未登录本来就走不到付费那一步；
 *    在这里弹窗只会打断登录流程。（服务端仍会在 `/generate` 二次校验，绕不过。）
 * 2. **每年重问一次**：服务端按 `adultAgreementVer` 版本号校验，协议改版后
 *    旧勾选自动失效，用户会被再问一次 —— 这是合规要求，不是骚扰。
 * 3. **只收出生年份**：判 18+ 和人群口径（18–30）用年份就够，少收一个精确生日
 *    就少一份个人信息（最小必要原则）。
 */

import { apiFetch } from './api-fetch.js';
import { getAuthToken } from './auth.js';

let modalEl = null;
let resolver = null;

function buildModal() {
  if (modalEl) return modalEl;
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.innerHTML = `
    <div class="modal-backdrop" data-close></div>
    <div class="modal-box" role="document">
      <h3>成年用户确认</h3>
      <p class="modal-hint">本产品面向 <strong>18–30 岁成年人</strong>，提供情感避坑与配对报告服务。
        为遵守相关法规，需要先确认你的出生年份。</p>
      <label class="field-label" for="adult-birthyear">出生年份</label>
      <select id="adult-birthyear" class="input">
        <option value="">请选择</option>
      </select>
      <label class="adult-agree">
        <input type="checkbox" id="adult-agree-box">
        <span>我已阅读并同意《成年用户承诺》：我确认已年满 18 周岁，且理解本产品不构成心理或法律建议。</span>
      </label>
      <p class="modal-hint" id="adult-error" style="color:#e74c3c;display:none"></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" data-close>暂不</button>
        <button type="button" class="btn btn-primary" id="adult-submit">确认</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  // 年份下拉：从今年往前 60 年（覆盖 18–30 岁区间，也允许更大年龄自我声明）
  const sel = wrap.querySelector('#adult-birthyear');
  const thisYear = new Date().getFullYear();
  for (let y = thisYear; y >= thisYear - 60; y -= 1) {
    const opt = document.createElement('option');
    opt.value = String(y);
    opt.textContent = `${y} 年（${thisYear - y} 岁）`;
    sel.appendChild(opt);
  }

  wrap.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close(false);
  });
  wrap.querySelector('#adult-submit').addEventListener('click', submit);

  modalEl = wrap;
  return wrap;
}

function close(result) {
  if (modalEl) modalEl.classList.remove('open');
  if (resolver) {
    const r = resolver;
    resolver = null;
    r(result);
  }
}

function showError(msg) {
  const el = modalEl?.querySelector('#adult-error');
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

async function submit() {
  const birthYear = Number(modalEl.querySelector('#adult-birthyear').value);
  const agreed = modalEl.querySelector('#adult-agree-box').checked;
  if (!birthYear) return showError('请选择出生年份');
  if (!agreed) return showError('请先勾选《成年用户承诺》');

  const btn = modalEl.querySelector('#adult-submit');
  btn.disabled = true;
  try {
    const res = await apiFetch('/v1/profile/adult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ birthYear }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      showError(json.error || '提交失败，请重试');
      return;
    }
    close(true);
  } catch {
    showError('网络异常，请稍后重试');
  } finally {
    btn.disabled = false;
  }
}

/**
 * 确保当前用户已过年龄门；未过则弹窗收集，返回是否通过。
 * @param {{action?: string}} [opts]
 * @returns {Promise<boolean>}
 */
export async function ensureAdult({ action = '继续' } = {}) {
  if (!getAuthToken()) return true; // 未登录：交给登录流程处理，服务端仍会拦

  try {
    const res = await apiFetch('/v1/profile/adult');
    if (res.ok) {
      const json = await res.json().catch(() => ({}));
      if (json?.data?.ok) return true;
    }
  } catch {
    /* 网络异常按"未通过"处理，让服务端兜底 */
  }

  buildModal();
  // 弹窗里补一句"为什么现在问"，让用户知道不是随机弹的
  const hint = modalEl.querySelector('h3');
  if (hint) hint.textContent = `成年用户确认（${action}前）`;
  modalEl.classList.add('open');

  return new Promise((resolve) => {
    resolver = resolve;
  });
}

/** 供其它模块判断（例如 402 时决定是否弹年龄门） */
export async function adultPassed() {
  if (!getAuthToken()) return true;
  try {
    const res = await apiFetch('/v1/profile/adult');
    if (!res.ok) return false;
    const json = await res.json().catch(() => ({}));
    return Boolean(json?.data?.ok);
  } catch {
    return false;
  }
}
