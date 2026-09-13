/**
 * 安装偏好引导（OnboardingContinuation）的「关闭/跳过」必须是纯前端行为：
 * 只写引导专用键，绝不调用 markSetupDone，也不写入任何后端 setup 状态
 * （与 setup/state.ts 的 butler.setup.* 键完全隔离）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dismissOnboardingContinuation, readOnboardingDismissed } from "../src/pages/dashboard/onboardingDismiss.js";

describe("安装偏好引导的纯前端关闭", () => {
  let store: Record<string, string> | null = null;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    store = {};
    originalWindow = globalThis.window;
    // 最小 localStorage 替身：验证 dismiss 只写自己的键、不碰 setup 完成键。
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem: (k: string) => (store !== null && k in store ? store[k]! : null),
        setItem: (k: string, v: string) => {
          if (store !== null) store[k] = v;
        },
        removeItem: (k: string) => {
          if (store !== null) delete store[k];
        },
      },
    };
  });

  afterEach(() => {
    (globalThis as unknown as { window: unknown }).window = originalWindow;
  });

  it("默认未关闭", () => {
    expect(readOnboardingDismissed()).toBe(false);
  });

  it("关闭后记为已关闭，且只写引导专用键", () => {
    dismissOnboardingContinuation();
    expect(readOnboardingDismissed()).toBe(true);
    expect(store).toHaveProperty("butler.onboarding-continuation.dismissed", "1");
    // 关键验收：关闭不得标记「安装已完成」、不得改任何后端 setup 状态。
    expect(store).not.toHaveProperty("butler.setup.completed");
    expect(store).not.toHaveProperty("butler.setup.preferences");
  });

  it("存储不可用时静默失败，不会抛错", () => {
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem: () => {
          throw new Error("nope");
        },
        setItem: () => {
          throw new Error("nope");
        },
        removeItem: () => {
          throw new Error("nope");
        },
      },
    };
    expect(() => dismissOnboardingContinuation()).not.toThrow();
    expect(() => readOnboardingDismissed()).not.toThrow();
  });
});
