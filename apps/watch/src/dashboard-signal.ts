/**
 * Dashboard 语义化信号（可选补充信号）：
 * - 仅当 hermes config.yaml 声明 dashboard 段（readHermesConfig().hasDashboard）
 *   时才 GET <dashboardUrl>/api/status（可注入 fetch，默认 5s 超时）；
 * - 可达：解析 JSON 提取顶层标量键值子集作为 detail，confidence +0（补充信号）；
 * - 不可达：confidence -0.1 并生成 note（"Dashboard 不可达，仅降置信不判故障"），
 *   绝不产生 fail 检查项（skipped 表达不参与判定）；
 * - 未启用 dashboard：不发起任何请求，无信号。
 */
import { readHermesConfig } from "@butler/adapter-hermes";
import type { CheckResult } from "./pipeline.js";

/** 结构化 fetch 注入签名（默认包装全局 fetch，测试用 fake）。 */
export interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface ResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init?: FetchInitLike) => Promise<ResponseLike>;

export const defaultFetchLike: FetchLike = (url, init) => fetch(url, init);

export const DASHBOARD_SIGNAL_CHECK_ID = "dashboard-signal";
export const DASHBOARD_UNREACHABLE_NOTE = "Dashboard 不可达，仅降置信不判故障";
/** 顶层键值子集最多提取的标量键数量。 */
const DETAIL_MAX_KEYS = 5;

export interface DashboardSignalOutcome {
  /** 追加到巡检 checks 的补充信号（pass / skipped，绝不 fail）；未启用时无。 */
  check?: CheckResult;
  /** 置信度调整量：可达 +0，不可达 -0.1。 */
  confidenceDelta: number;
  /** 不可达原因说明（note）。 */
  note?: string;
}

export interface DashboardSignalOptions {
  rootPath: string;
  dashboardUrl: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

/** 探测 Dashboard /api/status 语义化信号。 */
export async function probeDashboardSignal(options: DashboardSignalOptions): Promise<DashboardSignalOutcome> {
  const config = await readHermesConfig(options.rootPath);
  if (config === null || !config.hasDashboard) {
    return { confidenceDelta: 0 };
  }

  const doFetch = options.fetchFn ?? defaultFetchLike;
  const timeoutMs = options.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${options.dashboardUrl.replace(/\/+$/, "")}/api/status`;
    const response = await doFetch(url, { method: "GET", signal: controller.signal });
    if (!response.ok) return unreachable(`HTTP ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      return unreachable(`响应非 JSON: ${describe(error)}`);
    }
    const detail = summarizeTopLevel(body);
    if (detail === null) return unreachable("响应无顶层标量键");
    return {
      check: { id: DASHBOARD_SIGNAL_CHECK_ID, status: "pass", detail },
      confidenceDelta: 0,
    };
  } catch (error) {
    return unreachable(describe(error));
  } finally {
    clearTimeout(timer);
  }
}

function unreachable(reason: string): DashboardSignalOutcome {
  return {
    check: { id: DASHBOARD_SIGNAL_CHECK_ID, status: "skipped", detail: `${DASHBOARD_UNREACHABLE_NOTE}（${reason}）` },
    confidenceDelta: -0.1,
    note: DASHBOARD_UNREACHABLE_NOTE,
  };
}

/** 提取顶层标量键值子集（k=v 空格连接，最多 5 个）；无标量键返回 null。 */
function summarizeTopLevel(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${value}`);
      if (parts.length >= DETAIL_MAX_KEYS) break;
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
