import { ref } from 'vue';

/** 自定义顶栏高度（微信 / 支付宝 / 抖音 / 小红书小程序通用） */
export function useNavBar() {
  const statusBarPx = ref(20);
  const navBarPx = ref(44);
  const navTotalPx = ref(64);
  /** Tab 页整页高度（px，含状态栏，不含 tabBar；勿用 100vh） */
  const pageHeightPx = ref(667);
  /** 顶栏下方可滚动/可点击区域高度（px） */
  const bodyHeightPx = ref(600);

  function initNavBar() {
    const sys = uni.getSystemInfoSync();
    const sb = sys.statusBarHeight || 20;
    statusBarPx.value = sb;
    let bar = 44;
    // #ifdef MP
    try {
      const menu = uni.getMenuButtonBoundingClientRect();
      if (menu?.height) {
        bar = (menu.top - sb) * 2 + menu.height;
      }
    } catch {
      /* ignore */
    }
    // #endif
    navBarPx.value = bar;
    navTotalPx.value = sb + bar;
    pageHeightPx.value = sys.windowHeight || 600;
    bodyHeightPx.value = Math.max(320, pageHeightPx.value - navTotalPx.value);
  }

  initNavBar();

  return { statusBarPx, navBarPx, navTotalPx, pageHeightPx, bodyHeightPx, initNavBar };
}
