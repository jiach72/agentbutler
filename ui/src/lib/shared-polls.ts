/**
 * 共享轮询源（审计 F-2）：同一端点被多个组件独立轮询时，收敛为一次请求、多处订阅。
 *
 * 背景：侧栏计数、待批横幅、审批卡片各自以不同 limit 轮询 /api/approvals（30s×3），
 * 顶栏与移动端 Tab 的急停按钮各自轮询 /api/killswitch（10s×2）——仪表盘一个刷新
 * 周期打出十几个请求，其中近半是重复。SharedPoll 以引用计数维持单一间隔，
 * 数据按内容判等（不变不通知），后台标签页暂停拉取（与 usePolling 可见性语义一致）。
 */
import { useSyncExternalStore } from "react";
import { loadJson } from "./api.js";

export interface SharedPollSnapshot<T> {
  data: T | null;
  /** 最近一次拉取是否成功；null = 尚未拉取过。 */
  ok: boolean | null;
}

export class SharedPoll<T> {
  private data: T | null = null;
  private ok: boolean | null = null;
  private snapshot: SharedPollSnapshot<T> = { data: null, ok: null };
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    private readonly intervalMs: number,
  ) {}

  /** 立即拉取一次（组件操作写库后调用，让所有订阅方同步刷新）。 */
  refresh = async (): Promise<void> => {
    if (this.inFlight) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    this.inFlight = true;
    try {
      const result = await loadJson<T>(this.url, this.timeoutMs);
      if (result.ok) {
        const next = result.data;
        if (JSON.stringify(next) !== JSON.stringify(this.data)) {
          this.data = next;
          this.notify(true);
        } else if (this.ok === false) {
          this.notify(true); // 从失败恢复但内容未变，也要让 reachable 态回到 true
        }
      } else if (this.ok !== false) {
        this.notify(false);
      }
    } finally {
      this.inFlight = false;
    }
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.timer === null) {
      this.timer = setInterval(() => void this.refresh(), this.intervalMs);
      void this.refresh();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  };

  getSnapshot = (): SharedPollSnapshot<T> => this.snapshot;

  private notify(ok: boolean): void {
    this.ok = ok;
    // 只有内容/可达性变化时才重建快照对象——useSyncExternalStore 依赖引用相等跳过重渲染。
    this.snapshot = { data: this.data, ok };
    for (const listener of this.listeners) listener();
  }
}

/** 订阅共享轮询源；数据内容不变时返回同一引用，订阅方不重渲染。 */
export function useSharedPoll<T>(poll: SharedPoll<T>): SharedPollSnapshot<T> {
  return useSyncExternalStore(poll.subscribe, poll.getSnapshot, poll.getSnapshot);
}

/** 待处理审批：侧栏计数 / 顶部横幅 / 审批卡片共用一次 limit=20 拉取（30s）。 */
export interface ApprovalsPendingPayload {
  items?: Array<{ id: string; detail?: unknown }>;
  summary?: { pending?: number };
}
export const approvalsPendingPoll = new SharedPoll<ApprovalsPendingPayload>(
  "/api/approvals?status=pending&limit=20",
  8_000,
  30_000,
);

/** 紧急暂停状态：顶栏按钮与移动端 Tab 双实例共用（10s）。 */
export interface KillSwitchStateSnapshot {
  engaged: boolean;
  engagedAt: string | null;
  stoppedInstanceIds: string[];
  snapshotTaken: boolean;
  snapshotId: number | null;
  releasedAt: string | null;
  restoredFromLog: boolean;
}
export const killswitchStatePoll = new SharedPoll<KillSwitchStateSnapshot>(
  "/api/killswitch",
  6_000,
  10_000,
);

/** 访问范围（发布地址 + 是否设置口令）：首页安全位展示用；部署期配置，5 分钟复核一次。 */
export interface AccessBaseline {
  listenHost?: string;
  publishHost?: string;
  loopback?: boolean;
  auth?: boolean;
}
export const securityBaselinePoll = new SharedPoll<AccessBaseline>(
  "/api/security-baseline",
  8_000,
  300_000,
);
