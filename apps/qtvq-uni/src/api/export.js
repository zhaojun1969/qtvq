/**
 * 本人数据导出（小程序端）
 *
 * 与 H5 的差别不是"少给数据"，而是**文件怎么交给用户**：
 * 浏览器可以直接 `a[download]`；小程序没有下载目录，落盘后用户找不到。
 * 能走通的路径只有一条被微信支持的：写进 `USER_DATA_PATH` → `shareFileMessage`
 * 让用户发给自己（文件传输助手），这样文件真正落到用户手里。
 *
 * 两个必须如实处理的边界：
 *   · `shareFileMessage` 需要基础库 2.16.1+，且必须由**用户点击**触发。
 *     低版本或调用失败时不能假装成功 —— 退到"复制到剪贴板"，
 *     并在文案里说清"完整文件请到网页版下载"，不留下一个假的成功提示。
 *   · 剪贴板有大小上限，数据量大的账号复制会失败。此时明确提示去网页版，
 *     而不是静默截断（截断后的 JSON 既打不开也看不出少了什么）。
 */
import { get } from './request.js';

const FILE_NAME = 'qtvq-my-data.json';
const CLIPBOARD_LIMIT = 200 * 1024; // 保守值：微信剪贴板实际上限大于此，但留足余量

export function fetchMyData() {
  return get('/v1/me/export');
}

function writeFile(filePath, text) {
  return new Promise((resolve, reject) => {
    // #ifdef MP-WEIXIN
    wx.getFileSystemManager().writeFile({
      filePath,
      encoding: 'utf8',
      data: text,
      success: resolve,
      fail: reject,
    });
    // #endif
    // #ifndef MP-WEIXIN
    reject(new Error('当前端不支持保存文件'));
    // #endif
  });
}

function shareFile(filePath) {
  return new Promise((resolve, reject) => {
    // #ifdef MP-WEIXIN
    if (typeof wx.shareFileMessage !== 'function') {
      reject(new Error('当前微信版本不支持发送文件'));
      return;
    }
    wx.shareFileMessage({
      filePath,
      fileName: FILE_NAME,
      success: resolve,
      fail: reject,
    });
    // #endif
    // #ifndef MP-WEIXIN
    reject(new Error('当前端不支持发送文件'));
    // #endif
  });
}

/**
 * 把数据写到文件并发给自己。
 * @returns {Promise<{mode:'file'|'clipboard'}>}
 */
export async function shareMyData(data) {
  const text = JSON.stringify(data, null, 2);
  // #ifdef MP-WEIXIN
  const filePath = `${wx.env.USER_DATA_PATH}/${FILE_NAME}`;
  try {
    await writeFile(filePath, text);
    await shareFile(filePath);
    return { mode: 'file' };
  } catch (err) {
    // 文件路径失败时不直接放弃：剪贴板对小账号仍然可用
    if (text.length <= CLIPBOARD_LIMIT) {
      await new Promise((resolve, reject) => {
        uni.setClipboardData({
          data: text,
          success: resolve,
          fail: reject,
        });
      });
      return { mode: 'clipboard' };
    }
    throw err;
  }
  // #endif
  // #ifndef MP-WEIXIN
  if (text.length > CLIPBOARD_LIMIT) throw new Error('数据较多，请到网页版 account.html 下载完整文件');
  await new Promise((resolve, reject) => {
    uni.setClipboardData({ data: text, success: resolve, fail: reject });
  });
  return { mode: 'clipboard' };
  // #endif
}
