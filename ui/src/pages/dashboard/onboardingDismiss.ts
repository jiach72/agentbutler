/**
 * 安装偏好引导（OnboardingContinuation）的「关闭 / 跳过」状态。
 *
 * 纯前端：只记录「用户选择跳过引导」，绝不调用 markSetupDone，
 * 也不写入任何后端 setup 状态（与 setup/state.ts 的 `butler.setup.*` 键完全隔离）。
 * 这样关闭引导不会改变「安装已完成」等任何持久化结论。
 */
const DISMISS_KEY = "butler.onboarding-continuation.dismissed";

export function readOnboardingDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissOnboardingContinuation(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // 隐私模式 / 存储不可用时静默失败：引导仍然关闭（纯前端），不抛错。
  }
}
