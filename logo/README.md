# Q问 Logo 导出

源文件：[`../assets/logo.svg`](../assets/logo.svg)（圆环 + 书法「问」+ Q 捺）

| 文件 | 尺寸 | 用途建议 |
|------|------|----------|
| `28-28.png` | 28×28 | 浏览器 favicon 小图标、工具栏 |
| `108-108.png` | 108×108 | iOS/Android 小图标 |
| `256-256.png` | 256×256 | PWA、桌面快捷方式 |
| `512-512.png` | 512×512 | 应用商店、启动图 |
| `1024-1024.png` | 1024×1024 | App Store、高清物料 |

## 重新生成

修改 `assets/logo.svg` 后执行：

```bash
npm run logo:export
```

脚本：`tools/scripts/export-logo-png.js`（基于 `@resvg/resvg-js`）
