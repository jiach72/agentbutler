import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";import {
  applyThemeCssBridge,
  initialThemeMode,
  themeConfigFor,
  writeStoredThemeMode,
  type ThemeMode,
} from "./tokens.js";

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * 主题切换的交叉淡入（评审阶段 C · 动效体系）。
 *
 * 用 View Transitions API 让「旧主题整帧淡出、新主题整帧淡入」，
 * 避免 setMode 触发的上百个 token 同时跳变造成的"闪变"。
 * 三个安全阀：
 *   · 浏览器不支持（Firefox / 旧 Safari）→ 直接切换，无动画也无害；
 *   · 用户开了 prefers-reduced-motion → 不启动过渡（motion.css 里也已全局降级）；
 *   · 过渡是纯合成器动画（只动 opacity），不触发布局。
 */
function withThemeTransition(apply: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (typeof doc.startViewTransition !== "function" || reduced) {
    apply();
    return;
  }
  doc.startViewTransition(apply);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() =>
    initialThemeMode(
      getLocalStorage(),
      typeof window === "undefined" ? undefined : (query) => window.matchMedia(query),
    ),
  );

  // setMode 只会被用户动作调用（初始主题由 useState 初始化器决定），
  // 所以这里始终走过渡；首屏不会有动画。
  const setMode = useCallback((nextMode: ThemeMode) => {
    withThemeTransition(() => {
      setModeState(nextMode);
      try {
        if (typeof window !== "undefined") writeStoredThemeMode(window.localStorage, nextMode);
      } catch {
        // Private browsing and locked-down WebViews may reject storage access.
      }
    });
  }, []);

  const toggleMode = useCallback(() => {
    setMode(mode === "dark" ? "light" : "dark");
  }, [mode, setMode]);

  useEffect(() => {
    applyThemeCssBridge(mode);
  }, [mode]);

  const value = useMemo(() => ({ mode, setMode, toggleMode }), [mode, setMode, toggleMode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function getLocalStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}

export function antdThemeFor(mode: ThemeMode) {
  return themeConfigFor(mode);
}
