/**
 * 排查向导的「现象 → 动作偏好」映射。
 *
 * 设计要点：
 * - 选项是用户自己的话（"它不回我消息了"），不是技术分类（"channel-probe fail"）。
 *   小白不知道什么叫消息通道，但他知道 AI 不理他了。
 * - 选择只影响**排序**，不影响**可见性**。用户选错现象不至于看不到真正有用的动作，
 *   所有证据和动作始终完整呈现——向导是帮他找重点，不是替他做决定。
 */

export type SymptomId = "no-reply" | "slow" | "error" | "after-update" | "not-sure";

export interface Symptom {
  id: SymptomId;
  /** 一句话现象，第一人称视角。 */
  label: string;
  /** 选中后的补充说明，解释管家会重点查什么。 */
  hint: string;
  /** 该现象下优先考虑的动作 id，按优先级排列。 */
  preferredActions: readonly string[];
}

export const SYMPTOMS: readonly Symptom[] = [
  {
    id: "no-reply",
    label: "它不回我消息了",
    hint: "重点查消息通道是否断连、网关是否卡住。",
    preferredActions: ["reconnect-channel", "cleanup-gateway", "refresh-probe", "restart-instance"],
  },
  {
    id: "slow",
    label: "它变慢了，或者总是超时",
    hint: "重点查是否被限流、资源是否吃紧。",
    preferredActions: ["apply-throttle-patch", "refresh-probe", "restart-instance"],
  },
  {
    id: "error",
    label: "它报错了，我看不懂",
    hint: "重点查最近的错误日志和记忆索引。",
    preferredActions: ["rebuild-memory-index", "refresh-probe", "restart-instance"],
  },
  {
    id: "after-update",
    label: "更新之后就不对了",
    hint: "重点查版本变更带来的配置与兼容性问题。",
    preferredActions: ["restart-instance", "refresh-probe", "rebuild-memory-index"],
  },
  {
    id: "not-sure",
    label: "说不上来，你帮我查",
    hint: "按风险从低到高依次排查，先试最不影响使用的。",
    preferredActions: [],
  },
];

export const DEFAULT_SYMPTOM: SymptomId = "not-sure";

export function isSymptomId(value: string | null): value is SymptomId {
  return SYMPTOMS.some((symptom) => symptom.id === value);
}

export function findSymptom(id: SymptomId): Symptom {
  return SYMPTOMS.find((item) => item.id === id) ?? SYMPTOMS[SYMPTOMS.length - 1]!;
}

interface RankableAction {
  id: string;
  available: boolean;
  risk: "low" | "medium" | "high";
}

const RISK_ORDER: Record<RankableAction["risk"], number> = { low: 0, medium: 1, high: 2 };

/**
 * 按「可用 → 现象偏好 → 风险从低到高」排序。
 * 不可用的动作始终排在最后，但不会被过滤掉——用户需要知道为什么不能做。
 */
export function rankActions<T extends RankableAction>(actions: readonly T[], symptom: SymptomId): T[] {
  const preferred = findSymptom(symptom).preferredActions;
  return [...actions].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    const ai = preferred.indexOf(a.id);
    const bi = preferred.indexOf(b.id);
    // 未列入偏好的动作排在列入偏好的后面
    const aw = ai === -1 ? preferred.length : ai;
    const bw = bi === -1 ? preferred.length : bi;
    if (aw !== bw) return aw - bw;
    return RISK_ORDER[a.risk] - RISK_ORDER[b.risk];
  });
}

/** 推荐项：排序后第一个可用动作；没有可用动作时为 null。 */
export function recommendAction<T extends RankableAction>(
  actions: readonly T[],
  symptom: SymptomId,
): T | null {
  const ranked = rankActions(actions, symptom);
  return ranked.find((action) => action.available) ?? null;
}
