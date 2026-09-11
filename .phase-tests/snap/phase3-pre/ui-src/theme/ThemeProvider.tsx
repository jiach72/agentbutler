import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
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

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() =>
    initialThemeMode(
      getLocalStorage(),
      typeof window === "undefined" ? undefined : (query) => window.matchMedia(query),
    ),
  );

  const setMode = useCallback((nextMode: ThemeMode) => {
    setModeState(nextMode);
    try {
      if (typeof window !== "undefined") writeStoredThemeMode(window.localStorage, nextMode);
    } catch {
      // Private browsing and locked-down WebViews may reject storage access.
    }
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
