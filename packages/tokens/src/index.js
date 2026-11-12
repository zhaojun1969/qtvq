/**
 * Q问 · 设计令牌（唯一来源）
 *
 * 为什么要有这个包
 * ----------------
 * 官网 `css/styles.css` 有 14 个 CSS 变量，小程序端**零变量、全部硬编码**。
 * 实测漂移（2026-10-25）：
 *   · 小程序 `#ff6b81` 出现 25 次、`#a0a0b0` 19 次、`#ff8fa3` 14 次 —— 与官网同名同值，但各写各的；
 *   · 小程序还额外用了 `#9a9ab0`(23) `#14141c`(14) `#e8e8f0`(13) `#c8c8d8`(8) `#d8d8e2`(6)
 *     —— 这些色值在官网变量里**根本没有定义**，属于只有一端存在的"野生色"；
 *   · 官网 `css/styles.css:1867` 用了 `var(--purple-light)`，而 `--purple-light` **从未定义**
 *     —— 该声明实际无效，颜色回退到继承值，是一处静默 bug。
 *
 * 做法
 * ----
 * 本文件是唯一来源；`tools/scripts/gen-tokens.mjs` 据此生成两端产物：
 *   · 官网  → `css/tokens.css` 的 `:root` 块（CSS 自定义属性，运行时可用）
 *   · 小程序 → `apps/qtvq-uni/src/uni.scss`（SCSS 变量，uni-app 自动注入每个 SFC，编译期可用）
 *
 * 为什么两端用不同机制
 * --------------------
 * 官网早已在用 CSS 变量（45+ 处 `var(--text-muted)`），继续用零迁移成本；
 * 小程序端 5 个页面的 `<style>` 是**纯 CSS**，SCSS 变量只有在 `lang="scss"` 下才成立，
 * 因此产物选择 SCSS 变量 + 统一把纯 CSS 的 style 块升级为 scss，避免引入运行时依赖。
 *
 * 边界
 * ----
 * 本包只放**纯值**：不含 DOM、不含平台 API、不含单位换算函数以外的逻辑。
 * 单位约定：本文件用 px；生成小程序产物时自动 ×2 转 rpx（750 设计稿）。
 */

/** 颜色 —— 键名与官网既有 CSS 变量一一对应，避免大范围改名 */
export const COLOR = {
  // 主色
  pink: '#ff6b81',
  /** 动作色（E.80 WCAG AA）：白字底用。品牌粉 #ff6b81 白字仅 2.74:1（<4.5 不达标），
   *  加深至 #cc4560 = 4.58:1，与紫端 #6c5ce7(4.86) 同档；品牌粉保留用于装饰/描边。 */
  pinkAction: '#cc4560',
  pinkLight: '#ff8fa3',
  pinkSoft: '#ff9db0',
  purple: '#6c5ce7',
  purpleDark: '#5a4bd1',
  /** 补齐历史缺口：styles.css:1867 在用但从未定义 */
  purpleLight: '#8b7cf0',

  // 背景
  bg: '#0f0e17',
  bgDeep: '#14141c',
  bgCard: '#1a1928',
  bgElevated: '#242338',

  // 文本
  text: '#f5f5f7',
  textBright: '#e8e8f0',
  textSoft: '#c8c8d8',
  textSofter: '#d8d8e2',
  textMuted: '#a0a0b0',
  textDim: '#9a9ab0',
  textFaint: '#707080',

  /*
   * 语义色 —— 迁移时逐页统计得出（≥2 次出现才入册），不是拍脑袋定的：
   *   #ff8a8a 5 次 / #1c1c28 4 次 / #5ad07a 3 次 / #2a2940 2 次
   *   #707080 2 次 / #ffd479 2 次 / #1a1925 2 次 / #7bed9f 2 次
   *
   * 2026-10-28 复核后的两处调整：
   *   ① `#07c160`（微信品牌绿）原来被判为"只出现 1 次，不入册"，实际**两端都在用**
   *      （官网 styles.css 的订阅消息提示、小程序 account.vue 的微信登录按钮）——
   *      两端各写一份字面量就是漂移的起点，故升格为 `brandWechat`。
   *   ② 新增 `danger` / `dangerText`：官网"注销账号"危险区用的红（rgba(255,92,92,…)）
   *      与按钮文字 `#ff8080` 从来没有变量，小程序只好自己发明了 `#e74c3c`/`#c0392b`/
   *      `#ff7675` 三个"近似红"。入册之后两端才有同一档红可用。
   * 仍然不入册的：`#ff7675` `#9b8cff` `#c0392b` —— 它们是上面两个源的**复制粘贴变异**
   * （同一用途、色值略有偏差），一律映射回 `dangerSoft`/`purpleLight`/`danger`，
   * 而不是再养三个新令牌。
   */
  successSoft: '#5ad07a',
  successBright: '#7bed9f',
  warning: '#ffd479',
  dangerSoft: '#ff8a8a',
  /** 危险区基色：官网 rgba(255,92,92,α) 系列的不透明形态 */
  danger: '#ff5c5c',
  /** 危险按钮文字色：官网 `.btn.btn-danger` 与危险区标题实际取值 */
  dangerText: '#ff8080',
  /** 微信品牌绿：登录/订阅类按钮，两端共用 */
  brandWechat: '#07c160',

  // 背景补充色阶
  bgSunken: '#1c1c28',
  bgRaised: '#2a2940',
  bgCardAlt: '#1a1925',
};

/** 圆角（px） */
export const RADIUS = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
};

/** 间距（px） */
export const SPACE = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

/** 字体栈（两端一致） */
export const FONT_STACK = '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';

/** 渐变：动作面（按钮等白字 CTA）用 AA 达标的 pinkAction → purple（E.80，4.58/4.86）。
 *  品牌视觉的装饰渐变（logo SVG 等）不受影响——它们用各自独立色值。 */
export const GRADIENT = 'linear-gradient(135deg, #cc4560 0%, #6c5ce7 100%)';

/** 阴影（官网既有） */
export const SHADOW = '0 8px 32px rgba(108, 92, 231, 0.25)';

/** px → rpx（小程序 750 设计稿，1px = 2rpx） */
export function px2rpx(px) {
  return `${px * 2}rpx`;
}
