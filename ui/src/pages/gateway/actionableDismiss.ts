const DISMISSED_STORAGE_KEY = "butler.actionable-messages.dismissed";

/** 读取本地已忽略/已核实的消息 ID 集合 */
export function readDismissedMessageIds(): Set<string> {
  try {
    if (typeof window === "undefined" || !window.localStorage) return new Set();
    const raw = window.localStorage.getItem(DISMISSED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

/** 标记单条消息为已核实并忽略 */
export function dismissMessageId(messageId: string): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const current = readDismissedMessageIds();
    current.add(messageId);
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...current]));
  } catch {
    // 忽略 localStorage 写入错误
  }
}

/** 批量标记消息为已核实并忽略 */
export function dismissMessageIds(messageIds: string[]): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const current = readDismissedMessageIds();
    for (const id of messageIds) current.add(id);
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...current]));
  } catch {
    // 忽略 localStorage 写入错误
  }
}
