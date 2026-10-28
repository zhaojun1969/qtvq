# 我心永恒 Q问 · uni-app 多端



Android / iOS / 鸿蒙 / **微信** / **支付宝** / **抖音** / **小红书** 共用工程。



**当前版本：1.0.6** · **四端小程序 UI 与微信一致**（一套代码条件编译）



## 快速开始



```bash

cd apps/qtvq-uni

npm install



npm run dev:mp-weixin    # 微信

npm run dev:mp-alipay    # 支付宝

npm run dev:mp-toutiao   # 抖音

npm run dev:mp-xhs       # 小红书

npm run dev:h5           # 浏览器

```



**四端小程序指南** → [docs/MULTI-MINI-PROGRAM.md](./docs/MULTI-MINI-PROGRAM.md)  

**微信详细配置** → [docs/WEIXIN-ALIPAY.md](./docs/WEIXIN-ALIPAY.md)  

**顶栏与页面高度** → [docs/NAV-DESIGN.md](./docs/NAV-DESIGN.md)



## 一次编译四端



```bash

npm run build:mp-all

# 或仓库根目录：npm run build:mp-all

```



| 输出目录 | 工具 |

|----------|------|

| `dist/build/mp-weixin` | 微信开发者工具 |

| `dist/build/mp-alipay` | 支付宝开发者工具 |

| `dist/build/mp-toutiao` | 抖音开发者工具 |

| `dist/build/mp-xhs` | 小红书开发者工具 |



## 页面结构（四端相同）



| Tab / 页 | 说明 |

|----------|------|

| Q问 | 对话、10 条示例、热点、语音 |

| 避坑 | 10 条精选案例 |

| 缘值 | 额度、会员、关于（显示平台名） |

| 办理会员 | 微信端 JSAPI；其余端静态码 + 对公核实 |

| 我的账户 | 微信端一键登录；其余端手机号登录 |



## API



`https://qtvq-api.pages.dev`



会员规则：[docs/MEMBERSHIP-RULES.md](../../docs/MEMBERSHIP-RULES.md)

