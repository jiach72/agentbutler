export const TASK_DEFAULTS_KEY = "butler.scheduled-task-defaults";
export interface ScheduledTaskDefaults {
  deliveryEnabled: boolean;
}

export function readScheduledTaskDefaults(): ScheduledTaskDefaults {
  const fallback = { deliveryEnabled: false };
  try {
    const value: unknown = JSON.parse(localStorage.getItem(TASK_DEFAULTS_KEY) ?? "null");
    if (
      value !== null &&
      typeof value === "object" &&
      "deliveryEnabled" in value &&
      typeof value.deliveryEnabled === "boolean"
    ) {
      return { deliveryEnabled: value.deliveryEnabled };
    }
  } catch {
    /* Missing or blocked browser storage uses system defaults. */
  }
  return fallback;
}
