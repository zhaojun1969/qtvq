/**
 * Q问 · 中文文案目录（zh-CN）
 *
 * 为什么用 .js 而不是 .json
 * ------------------------
 * 计划书写的是 `zh-CN.json`，但浏览器原生 `import` 加载 JSON 需要 import assertion
 * (`with { type: 'json' }`)，各端支持参差；用 `export default { … }` 的 .js 文件
 * 在浏览器 / Node / Vite 三端零配置可用，且能通过 `check-shared-purity`（纯数据）。
 * 牺牲的是"不能用 JSON Schema 校验格式"，但键值都是字符串，风险可忽略。
 *
 * 命名约定
 * --------
 *   `<页面>.<元素>` —— 例如 `contact.title`、`contact.hint`
 *   `<页面>.<动作>` —— 例如 `contact.submit`、`contact.toastEmpty`
 *
 * 当前状态
 * --------
 * Phase 1 试点：仅 `contact` 页已抽离（9 个键）。
 * 全仓约 9000 处中文文案待抽离，列入后续迭代。
 */
export default {
  // ---- contact 页（留言客服）----
  'contact.title': '联系客服',
  'contact.hint': '留言将由人工客服处理。请勿填写银行卡密码等敏感信息。',
  'contact.placeholderMessage': '描述您的问题或建议…',
  'contact.placeholderEmail': '方便回复的邮箱（选填）',
  'contact.submit': '提交留言',
  'contact.toastEmpty': '请填写留言',
  'contact.modalTitle': '已提交',
  'contact.modalContent': '客服将尽快回复，感谢反馈。',
  'contact.toastFailed': '提交失败',
};
