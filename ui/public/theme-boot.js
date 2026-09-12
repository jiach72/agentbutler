/**
 * 主题引导（外置版）：首帧前同步设置 data-theme，避免暗色用户白屏闪烁。
 * 从 index.html 内联脚本外置而来——为了让 web 容器能下发不含 'unsafe-inline'
 * 的 script-src CSP（内联脚本会被 CSP 拦截，外置文件不受影响）。
 * 必须保持同步加载（head 中无 async/defer），否则首帧可能按亮色渲染。
 */
(() => {
  try {
    const stored = localStorage.getItem("butler.theme");
    const mode =
      stored === "light" || stored === "dark"
        ? stored
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
  } catch {
    document.documentElement.dataset.theme = "light";
  }
})();
