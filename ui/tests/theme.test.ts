import { describe, expect, it, vi } from "vitest";
import {
  initialThemeMode,
  readStoredThemeMode,
  systemThemeMode,
  THEME_STORAGE_KEY,
  writeStoredThemeMode,
} from "../src/theme/tokens.js";

describe("theme resolution", () => {
  it("prefers a valid persisted mode", () => {
    const storage = { getItem: vi.fn(() => "dark") };
    expect(readStoredThemeMode(storage)).toBe("dark");
    expect(storage.getItem).toHaveBeenCalledWith(THEME_STORAGE_KEY);
    expect(initialThemeMode(storage, () => ({ matches: false }))).toBe("dark");
  });

  it("falls back to the system mode for invalid or missing values", () => {
    expect(initialThemeMode({ getItem: () => "sepia" }, () => ({ matches: true }))).toBe("dark");
    expect(initialThemeMode({ getItem: () => null }, () => ({ matches: false }))).toBe("light");
    expect(initialThemeMode()).toBe("light");
  });

  it("fails safe when storage or media query access throws", () => {
    expect(readStoredThemeMode({ getItem: () => { throw new Error("locked"); } })).toBeNull();
    expect(systemThemeMode(() => { throw new Error("blocked"); })).toBe("light");
    expect(writeStoredThemeMode({ setItem: () => { throw new Error("locked"); } }, "dark")).toBe(false);
  });

  it("persists the selected mode under the stable key", () => {
    const setItem = vi.fn();
    expect(writeStoredThemeMode({ setItem }, "dark")).toBe(true);
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "dark");
  });
});
