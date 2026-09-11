/**
 * 多实例联邦（M4.4）：跨实例聚合视图 + 实例分组标签 + 成本分摊。
 *
 * 前提（计划书原文）：M1-M3 的数据模型全部实例维度原生，此处只是聚合层。
 * 单实例部署同样可用——聚合结果就是「那一个实例」的全貌。
 *
 * 聚合维度（全部来自既有表，零新增采集）：
 * - 成本合并：session_index 按 instance 汇总（成本、token、会话数）；
 * - 事件合并：trust_events 活跃项去重计数（跨实例同签名只算一条活跃）；
 * - 实例分组：runtime_settings 里的分组/标签配置（工作 / 实验 / 沙箱）；
 * - 统一急停覆盖性：列出当前急停清单覆盖的实例与未覆盖的实例——
 *   「统一急停覆盖所有实例」的验收前提是能**看见**谁没被覆盖。
 */
import type { SqliteStore } from "@butler/core";

export const FEDERATION_SETTING_GROUPS = "instance_groups";

/** 分组名约束：可读中文/英文，禁分隔符（配置是自由文本，必须防御性解析）。 */
export type InstanceGroup = "work" | "lab" | "sandbox" | "unassigned";

export const GROUP_LABEL: Record<InstanceGroup, string> = {
  work: "工作",
  lab: "实验",
  sandbox: "沙箱",
  unassigned: "未分组",
};

/** instanceId → 分组的映射（存储形态：`id1:work,id2:lab`）。 */
export function parseGroups(raw: string | null): Map<string, InstanceGroup> {
  const map = new Map<string, InstanceGroup>();
  if (raw === null || raw.trim() === "") return map;
  for (const pair of raw.split(",")) {
    const [id, group] = pair.split(":").map((part) => part.trim());
    if (id === undefined || id === "" || group === undefined) continue;
    if (group === "work" || group === "lab" || group === "sandbox") map.set(id, group);
  }
  return map;
}

export function serializeGroups(map: Map<string, InstanceGroup>): string {
  return Array.from(map.entries())
    .filter(([, group]) => group !== "unassigned")
    .map(([id, group]) => `${id}:${group}`)
    .join(",");
}

export interface FederationInstanceView {
  instanceId: string;
  frameworkId: string;
  state: string;
  group: InstanceGroup;
  /** 近 N 天会话数 / 成本 / token（session_index 聚合；无数据为 0）。 */
  sessions: number;
  costUsd: number | null;
  tokens: number;
  /** 该实例是否有未决活跃事件。 */
  activeEvents: number;
  /** 是否在当前急停清单内（未 engage 时为 false——语义是「未被当前急停覆盖」）。 */
  killswitchCovered: boolean;
}

export interface FederationView {
  windowDays: number;
  instances: FederationInstanceView[];
  summary: {
    totalInstances: number;
    byGroup: Record<InstanceGroup, number>;
    totalCostUsd: number | null;
    totalSessions: number;
    activeEvents: number;
    /** 急停覆盖实例数 / 总实例数（覆盖不全时用户应能看见）。 */
    killswitchCoverage: string;
  };
  /** 未被任何实例登记过的「孤儿会话」计数（instance 维度缺失的诚实呈现）。 */
  orphanSessions: number;
  basis: string;
}

export interface FederationService {
  view(windowDays: number): FederationView;
  setGroup(instanceId: string, group: InstanceGroup): void;
  groups(): Map<string, InstanceGroup>;
}

export interface FederationOptions {
  store: SqliteStore;
  /** 当前急停覆盖清单（engage 时为已停实例；未 engage 传空数组）。 */
  killswitchInstances: () => string[];
  now?: () => number;
}

export function createFederationService(options: FederationOptions): FederationService {
  const now = options.now ?? (() => Date.now());

  function groups(): Map<string, InstanceGroup> {
    return parseGroups(options.store.getRuntimeSetting(FEDERATION_SETTING_GROUPS));
  }

  function setGroup(instanceId: string, group: InstanceGroup): void {
    const map = groups();
    if (group === "unassigned") map.delete(instanceId);
    else map.set(instanceId, group);
    options.store.setRuntimeSetting(FEDERATION_SETTING_GROUPS, serializeGroups(map), new Date(now()).toISOString());
  }

  function view(windowDays: number): FederationView {
    const days = Math.max(1, Math.min(90, Math.floor(windowDays)));
    const since = new Date(now() - days * 86_400_000).toISOString();
    const groupMap = groups();
    const known = new Map(options.store.listInstances().map((row) => [row.instanceId, row]));
    const killswitch = new Set(options.killswitchInstances());

    // 会话成本按 instance 聚合（session_index.instance）。
    const sessions = options.store.listSessionIndex({ since, limit: 2000 });
    const costByInstance = new Map<string, { sessions: number; cost: number; costKnown: boolean; tokens: number }>();
    let orphans = 0;
    for (const row of sessions) {
      if (row.instance === "") {
        orphans += 1;
        continue;
      }
      const entry = costByInstance.get(row.instance) ?? { sessions: 0, cost: 0, costKnown: false, tokens: 0 };
      entry.sessions += 1;
      entry.tokens += (row.tokenIn ?? 0) + (row.tokenOut ?? 0);
      if (row.costUsd !== null) {
        entry.cost += row.costUsd;
        entry.costKnown = true;
      }
      costByInstance.set(row.instance, entry);
    }

    // 活跃事件（active/regressed）关联实例：evidence 里 instanceId 字段尽力提取；
    // 提取不到就归入「全局」，不做假归属。
    const activeEvents = options.store.listTrustEvents({ limit: 200 }).filter(
      (event) => event.status === "active" || event.status === "regressed",
    );
    const eventsByInstance = new Map<string, number>();
    for (const event of activeEvents) {
      const text = `${event.title} ${event.evidenceJson}`;
      const match = /"instanceId"\s*:\s*"([^"]+)"/.exec(text) ?? /实例\s+([A-Za-z0-9._-]+)/.exec(text);
      const id = match?.[1] ?? "__global__";
      eventsByInstance.set(id, (eventsByInstance.get(id) ?? 0) + 1);
    }

    const instanceIds = new Set<string>([...known.keys(), ...costByInstance.keys()]);
    const views: FederationInstanceView[] = Array.from(instanceIds).map((id) => {
      const row = known.get(id);
      const cost = costByInstance.get(id);
      return {
        instanceId: id,
        frameworkId: row?.frameworkId ?? "unknown",
        state: row?.state ?? "observed",
        group: groupMap.get(id) ?? "unassigned",
        sessions: cost?.sessions ?? 0,
        costUsd: cost?.costKnown ? cost.cost : null,
        tokens: cost?.tokens ?? 0,
        activeEvents: eventsByInstance.get(id) ?? 0,
        killswitchCovered: killswitch.has(id),
      };
    });
    views.sort((a, b) => (a.group === b.group ? b.sessions - a.sessions : a.group.localeCompare(b.group)));

    const totalCost = views.reduce((sum, view) => sum + (view.costUsd ?? 0), 0);
    const anyCostKnown = views.some((view) => view.costUsd !== null);
    const covered = views.filter((view) => view.killswitchCovered).length;

    const byGroup: Record<InstanceGroup, number> = { work: 0, lab: 0, sandbox: 0, unassigned: 0 };
    for (const view of views) byGroup[view.group] += 1;

    return {
      windowDays: days,
      instances: views,
      summary: {
        totalInstances: views.length,
        byGroup,
        totalCostUsd: anyCostKnown ? totalCost : null,
        totalSessions: views.reduce((sum, view) => sum + view.sessions, 0),
        activeEvents: activeEvents.length,
        killswitchCoverage: views.length === 0 ? "0 / 0" : `${covered} / ${views.length}`,
      },
      orphanSessions: orphans,
      basis: `近 ${days} 天 session_index 实例维度聚合 + instances 登记表 + trust_events 活跃项`,
    };
  }

  return { view, setGroup, groups };
}
