const SETUP_DONE_KEY = "butler.setup.completed";
const SETUP_PREFERENCES_KEY = "butler.setup.preferences";

export interface SetupPreferences {
  instanceId: string | null;
  templateId: string;
  completedAt: string;
}

export function markSetupDone(preferences: { instanceId: string | null; templateId: string }): void {
  try {
    window.localStorage.setItem(SETUP_DONE_KEY, "1");
    window.localStorage.setItem(
      SETUP_PREFERENCES_KEY,
      JSON.stringify({ ...preferences, completedAt: new Date().toISOString() }),
    );
  } catch { /* private mode */ }
}

export function isSetupCompleted(): boolean {
  try { return window.localStorage.getItem(SETUP_DONE_KEY) === "1"; } catch { return false; }
}

export function readSetupPreferences(): SetupPreferences | null {
  try {
    const raw = window.localStorage.getItem(SETUP_PREFERENCES_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const preferences = parsed as Record<string, unknown>;
    if (typeof preferences["templateId"] !== "string") return null;
    if (preferences["instanceId"] !== null && typeof preferences["instanceId"] !== "string") return null;
    return {
      templateId: preferences["templateId"],
      instanceId: preferences["instanceId"] as string | null,
      completedAt: typeof preferences["completedAt"] === "string" ? preferences["completedAt"] : "",
    };
  } catch {
    return null;
  }
}
