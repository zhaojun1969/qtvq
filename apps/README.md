# Q问 多端应用



| 目录 | 说明 | 状态 |

|------|------|------|

| `qtvq-uni/` | uni-app MVP（四端小程序 + 账户 + 会员） | ✅ **v1.0.6** |

| `../packages/api-client/` | 共享 API 协议（可选） | 待建 |



## 四端小程序（与微信同 UI）



| 平台 | 编译 | 输出 |

|------|------|------|

| 微信 | `npm run build:mp-weixin` | `dist/build/mp-weixin` |

| 支付宝 | `npm run build:mp-alipay` | `dist/build/mp-alipay` |

| 抖音 | `npm run build:mp-toutiao` | `dist/build/mp-toutiao` |

| 小红书 | `npm run build:mp-xhs` | `dist/build/mp-xhs` |

| 全部 | `npm run build:mp-all` | 上述四个目录 |



详见 **`qtvq-uni/docs/MULTI-MINI-PROGRAM.md`**。



## API



```

https://qtvq-api.pages.dev

```



完整方案见 **[docs/MULTI-PLATFORM.md](../docs/MULTI-PLATFORM.md)**。

