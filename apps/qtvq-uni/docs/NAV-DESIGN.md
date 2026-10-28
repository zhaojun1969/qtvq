# 小程序顶栏与页面高度规范（微信 / 支付宝 / 抖音）



三个 **Tab 页**（Q问、避坑、缘值）共用左侧 Logo 顶栏；顶栏中间按 Tab 显示不同文案。



## 布局



### Q问 Tab



```

┌─────────────────────────────────────┐

│ [Logo]      Q问          (胶囊)    │

│         我心永恒 · qtvq.cn          │

└─────────────────────────────────────┘

```



### 避坑 / 缘值 Tab



```

┌─────────────────────────────────────┐

│ [Logo]      避坑 / 缘值    (胶囊)  │

└─────────────────────────────────────┘

```



| 区域 | Q问 Tab | 避坑 / 缘值 Tab |

|------|---------|-----------------|

| **左侧** | Logo 固定 | Logo 固定 |

| **顶栏中间** | **Q问** + **我心永恒 · qtvq.cn** | **避坑** / **缘值**（与 tabBar 一致） |

| **底部 tabBar** | Q问 / 避坑 / 缘值 | 同上 |



## 页面高度（重要）



Tab 页 **不要用 `100vh`**。微信 Tab 页可用高度为 `windowHeight`（不含 tabBar），`100vh` 会偏大，导致 scroll 区域被撑进 tabBar 下方，**滚不到底**。



| 变量 | 来源 | 用途 |

|------|------|------|

| `pageHeightPx` | `sys.windowHeight` | 整页容器高度 |

| `bodyHeightPx` | `windowHeight - navTotalPx` | 顶栏下方内容区 |

| `navTotalPx` | 状态栏 + 胶囊行高 | BrandNavBar 占用 |



实现：`src/utils/navBar.js` → `initNavBar()`，在 `onLoad` / `onShow` / `onMounted` 调用。



```vue

<view class="page" :style="{ height: pageHeightPx + 'px' }">

  <BrandNavBar ... />

  <!-- 内容 -->

</view>

```



### 滚动策略



| 页面 | 方式 |

|------|------|

| **Q问** | 输入框固定底；上方 `scroll-view` 高度 = `bodyHeightPx - 输入区实测高度` |

| **避坑** | **页面原生滚动**（不用嵌套 scroll-view），底部留 `safe-area` |

| **缘值** | `scroll-view` 高度 = `bodyHeightPx`，勿与 `flex:1` 同用撑高 |



`scroll-view` 设了固定 `height` 时 **不要** 再加 `flex: 1`，否则会被 flex 拉长。



## 顶栏组件



| 文件 | 说明 |

|------|------|

| `src/components/BrandNavBar.vue` | `showBrandCenter` 或 `centerTitle`；**流式布局，非 fixed** |

| `src/utils/navBar.js` | 状态栏 + 胶囊高度 + `pageHeightPx` |

| `pages.json` | 三 Tab 页 `navigationStyle: "custom"` |



Q问 Tab：



```vue

<BrandNavBar

  :status-bar-px="statusBarPx"

  :nav-bar-px="navBarPx"

  :nav-total-px="navTotalPx"

  show-brand-center

/>

```



避坑 / 缘值 Tab：



```vue

<BrandNavBar

  :status-bar-px="statusBarPx"

  :nav-bar-px="navBarPx"

  :nav-total-px="navTotalPx"

  center-title="避坑"

/>

```



## 输入框（微信）



单行 `input` 若只有 `padding` 无固定高度，文字常 **上下只显示一半**。统一：



```scss

.input {

  height: 88rpx;

  line-height: 88rpx;

  padding: 0 24rpx;

  box-sizing: border-box;

}

```



已用于：`pages/account/account.vue`、`pages/subscribe/subscribe.vue`（`.field-lg` 为 96rpx）。



## 子页面（非 Tab）



如「办理会员」「我的账户」等仍用系统导航栏，无需 `BrandNavBar`；可整页原生滚动 + `padding-bottom`。

