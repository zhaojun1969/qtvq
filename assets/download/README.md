# 小程序码素材

这里是各平台小程序码图片的**唯一存放处**，由 `release-links.json` 的 `qrcode` 字段引用。

## 放什么

| 文件名 | 平台 | 建议尺寸 |
|---|---|---|
| `weixin-mp.png` | 微信 | ≥ 430×430（微信小程序码标准 430） |
| `alipay-mp.png` | 支付宝 | ≥ 300×300 |
| `kuaishou-mp.png` | 快手 | ≥ 300×300 |
| 其它平台同理 | `douyin` / `xhs` / `qq` / `baidu` / `jd` | ≥ 300×300 |

必须是 **PNG**。微信开发者工具导出时选 PNG，别用 JPEG（压缩噪点会拉低识别率）。

## 怎么放

不要手动改 `js/download-config.js`（那是生成文件，下次生成会被覆盖）。用脚本：

```bash
node tools/scripts/apply-mp-qrcode.mjs "D:/下载/小程序码.png"
node tools/scripts/apply-mp-qrcode.mjs "D:/下载/支付宝码.png" --platform alipay
```

脚本会校验尺寸、复制到本目录、写入 `release-links.json`、重新生成 `download-config.js`。

放好后：

```bash
node tools/scripts/check-mp-materials.mjs   # 小程序码一项应变为 ✅
```

## 目前状态

微信、支付宝等小程序码**尚未上传**，下载页对应卡片显示「小程序码 / 待上传」占位。
不放占位假图是刻意的：假二维码扫不出来，比"待上传"更糟。
