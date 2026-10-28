import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import uni from '@dcloudio/vite-plugin-uni';

/** 仓库根下的跨端共享层（网页 / 小程序 / 服务端共用同一份纯规则） */
const sharedEntry = fileURLToPath(new URL('../../packages/shared/src/index.js', import.meta.url));
/** 跨端文案查表（i18n 入口，纯函数） */
const i18nEntry = fileURLToPath(new URL('../../packages/i18n/src/index.js', import.meta.url));

export default defineConfig({
  /*
   * `@qtvq/shared` —— 指向仓库根的 `packages/shared`。
   *
   * 为什么需要 alias：Vite 默认**不允许 import 项目 root 之外的文件**
   * （小程序工程 root 是 `apps/qtvq-uni`，而 shared 在仓库根）。
   * 用 alias 显式指过去，比写一长串 `../../../../packages/...` 更稳（路径漂移时会立刻报错）。
   *
   * 目的（2026-10-11 两次真实事故驱动）：举报原因、收款渠道这类**同一份规则**
   * 以前网页写一遍、小程序再写一遍，于是：小程序举报原因少 3 项 → 举报必然 400；
   * 小程序收款渠道漏了 `autoCredit` → 用户以为付了就会自动到账。
   * 收到 shared 后，两端 import 同一份，结构上不再可能漂移。
   */
  resolve: {
    alias: {
      '@qtvq/shared': sharedEntry,
      '@qtvq/i18n': i18nEntry,
    },
  },
  /*
   * `base: './'` —— 让 H5 产物用**相对路径**引用 assets。
   *
   * 默认是 `'/'`（绝对路径），构建出来是 `/assets/index-xxx.js`。这在网页上没问题，
   * 但**桌面客户端（Electron）用 file:// 加载本地 H5 时会全部 404** ——
   * 因为 `/assets/...` 会被解析到磁盘根目录，界面直接白屏。
   *
   * 相对路径对两种场景都成立：
   *   · 部署在域名根（qtvq.cn）→ 相对与绝对等价；
   *   · 部署在子路径或本地 file://（桌面壳）→ 只有相对能用。
   */
  base: './',
  plugins: [uni()],
});
