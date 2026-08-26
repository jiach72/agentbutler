import { useCallback, useEffect, useState } from "react";

export const PREFERENCES_STORAGE_KEY = "butler.preferences";
export const PREFERENCES_CHANGED_EVENT = "butler-preferences-changed";

export interface ButlerPreferences {
  notificationMinSeverity: "warn" | "critical";
  notificationBadgeEnabled: boolean;
}

export const DEFAULT_PREFERENCES: ButlerPreferences = {
  notificationMinSeverity: "warn",
  notificationBadgeEnabled: true,
};

function parsePreferences(value: string | null): ButlerPreferences {
  if (value === null) return DEFAULT_PREFERENCES;
  try {
    const parsed = JSON.parse(value) as Partial<ButlerPreferences>;
    return {
      notificationMinSeverity:
        parsed.notificationMinSeverity === "critical" ? "critical" : "warn",
      notificationBadgeEnabled: parsed.notificationBadgeEnabled !== false,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function readPreferences(storage?: Pick<Storage, "getItem">): ButlerPreferences {
  try {
    return parsePreferences(storage?.getItem(PREFERENCES_STORAGE_KEY) ?? null);
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function writePreferences(
  storage: Pick<Storage, "setItem"> | undefined,
  preferences: ButlerPreferences,
): boolean {
  try {
    storage?.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

export function usePreferences(): [ButlerPreferences, (next: ButlerPreferences) => void] {
  const [preferences, setPreferences] = useState<ButlerPreferences>(() =>
    readPreferences(typeof window === "undefined" ? undefined : window.localStorage),
  );

  useEffect(() => {
    const sync = () =>
      setPreferences(readPreferences(typeof window === "undefined" ? undefined : window.localStorage));
    window.addEventListener(PREFERENCES_CHANGED_EVENT, sync);
    return () => window.removeEventListener(PREFERENCES_CHANGED_EVENT, sync);
  }, []);

  const update = useCallback((next: ButlerPreferences) => {
    writePreferences(typeof window === "undefined" ? undefined : window.localStorage, next);
    setPreferences(next);
    if (typeof window !== "undefined") window.dispatchEvent(new Event(PREFERENCES_CHANGED_EVENT));
  }, []);

  return [preferences, update];
}
