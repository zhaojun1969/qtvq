/**
 * 举报原因选择弹层（Web 端通用）
 *
 * 为什么必须有这个：服务端 `services/moderation.js` 的 `REPORT_REASONS` 是**白名单**
 * （涉黄 / 广告 / 诈骗 / 辱骂 / 头像违规 / 虚假资料 / 其他），`reason` 不在名单里会直接
 * 返回 400 `E_BAD_REASON 无效的举报原因`。
 *
 * 之前转盘页用 `prompt()` 让用户手打原因——多打一个空格、写成「色情」、或者干脆写一句话，
 * 提交必然失败，用户看到的是一个死胡同。所以这里改成：原因只能从白名单里选，
 * 想补充说明就写进 `detail`（服务端刻意不拦截 detail，否则用户没法描述违规内容）。
 */
import { REPORT_REASONS } from './report-api.js';

const OVERLAY_ID = 'report-reason-overlay';

/**
 * 打开举报弹层
 * @param {{ targetName?: string, title?: string }} opts
 * @returns {Promise<{ reason: string, detail: string } | null>} 取消返回 null
 */
export function pickReportReason(opts = {}) {
  return new Promise((resolve) => {
    document.getElementById(OVERLAY_ID)?.remove();

    const name = String(opts.targetName || '').slice(0, 20);
    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'report-reason-overlay';
    overlay.innerHTML = `
      <div class="report-reason-box" role="dialog" aria-modal="true" aria-label="举报">
        <h3>举报${name ? ` ${escapeAttr(name)}` : ''}</h3>
        <label for="report-reason-select">举报原因（必选）</label>
        <select id="report-reason-select">
          ${REPORT_REASONS.map((r) => `<option value="${escapeAttr(r)}">${escapeAttr(r)}</option>`).join('')}
        </select>
        <label for="report-reason-detail">补充说明（选填，最多 500 字）</label>
        <textarea id="report-reason-detail" maxlength="500"
          placeholder="请描述具体情况，例如：资料里留微信号引流。请勿填写手机号等个人信息。"></textarea>
        <p class="report-reason-hint">
          举报会提交给运营人工核实；同一对象当天只能举报一次。恶意举报会被记录。
        </p>
        <div class="report-reason-actions">
          <button type="button" class="btn btn-primary" id="report-reason-submit">提交举报</button>
          <button type="button" class="btn btn-secondary" id="report-reason-cancel">取消</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const done = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(null);
    };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) done(null);
    });
    document.getElementById('report-reason-submit').addEventListener('click', () => {
      done({
        reason: document.getElementById('report-reason-select').value,
        detail: document.getElementById('report-reason-detail').value.trim().slice(0, 500),
      });
    });
    document.getElementById('report-reason-cancel').addEventListener('click', () => done(null));
  });
}

function escapeAttr(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
