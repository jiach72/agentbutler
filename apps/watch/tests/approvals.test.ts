/**
 * M3.1 通知即操作测试：
 * - 决策链路：批准 / 拒绝 → 状态流转 + 审计 + 事件中心 + 告警归档；
 * - **超时默认拒绝 100% 生效**（验收硬指标）：到期自动 expired，不给「迟到的批准」开口子；
 * - **24h 内第 3 次升级**：同一动作指纹计数 → escalateRequired，通道侧一键放行被拒；
 * - 幂等：同一动作事件只开一张单，不重复推送/留痕；
 * - 高危动作增量侦测：只处理 id > watermark 的新行；
 * - HTTP 契约：列表 / 详情（404）/ 决策（409、410）/ 未接线（503）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog, EventBus, SqliteStore } from "@butler/core";
import {
  actionFingerprint,
  createApprovalService,
  describeAction,
  APPROVAL_APPROVED_ACTION,
  APPROVAL_BLOCKED_EVENT_KIND,
  APPROVAL_DENIED_ACTION,
  APPROVAL_EXPIRED_ACTION,
  APPROVAL_REQUESTED_ACTION,
  type ApprovalService,
} from "../src/approvals.js";
import { createTrustEventHub, type TrustEventHub } from "../src/trust-events.js";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";
import type { GatewayPanelService } from "../src/gateway-stats.js";
import type { UpgradeService } from "../src/upgrade.js";
import type { AlertPoster, GatewayAlertBody } from "../src/alert-forward.js";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "butler-approval-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      // Windows SQLite 句柄延迟释放；临时目录由操作系统回收
    }
  }
});

const upgradeStub: UpgradeService = {
  startUpgrade: () => ({ status: "missing-target-version" }),
  status: () => null,
  listVersions: async () => ({ reachable: false, versions: [] }),
  rollbackSnapshot: async () => ({ status: "snapshot-not-found" }),
};
const gatewayStub: GatewayPanelService = {
  stats: async () => ({ overall: "ok", totalEvents: 0, last24h: 0, matched: [], suggestions: [] }),
  patches: async () => [],
  applyPatch: async () => ({ status: "no-instance" }),
  reapplyPatch: async () => ({ status: "no-instance" }),
  detectPatch: async () => ({ status: "no-instance" }),
};

/** 可观测的推送桩：记录所有 post/resolve 调用，供断言「卡片送没送、归档没归档」。 */
function makePoster(): {
  poster: AlertPoster;
  posts: GatewayAlertBody[];
  resolved: string[];
} {
  const posts: GatewayAlertBody[] = [];
  const resolved: string[] = [];
  return {
    posts,
    resolved,
    poster: {
      post: async (body) => {
        posts.push(body);
      },
      resolve: async (dedupeKey) => {
        resolved.push(dedupeKey);
      },
      flush: async () => undefined,
    },
  };
}

/** 可控时钟：测试直接推进时间，不等真实 15 分钟。 */
function makeClock(start: number): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

let idSeq = 0;
function makeService(options: {
  ttlMs?: number;
  escalationThreshold?: number;
  escalationWindowMs?: number;
  autoDetect?: boolean;
  start?: number;
} = {}): {
  service: ApprovalService;
  store: SqliteStore;
  trustEvents: TrustEventHub;
  audit: AuditLog;
  posts: GatewayAlertBody[];
  resolved: string[];
  clock: { now: () => number; advance: (ms: number) => void };
} {
  const dir = makeTempDir();
  const store = new SqliteStore(join(dir, "butler.db"));
  // 用真实 AuditLog（而非桩）验证「批准/拒绝/超时确实入审计流」。
  const audit = new AuditLog({ store, bus: new EventBus() });
  const trustEvents = createTrustEventHub({ store });
  const clock = makeClock(options.start ?? Date.parse("2026-09-11T12:00:00Z"));
  const { poster, posts, resolved } = makePoster();
  idSeq = 0;
  const service = createApprovalService({
    store,
    trustEvents,
    audit,
    poster,
    publicBaseUrl: "https://butler.example.com",
    ttlMs: options.ttlMs ?? 15 * 60 * 1000,
    escalationThreshold: options.escalationThreshold ?? 3,
    escalationWindowMs: options.escalationWindowMs ?? 24 * 60 * 60 * 1000,
    autoDetect: options.autoDetect ?? false,
    now: clock.now,
    idFactory: () => `ap-${++idSeq}`,
  });
  return { service, store, trustEvents, audit, posts, resolved, clock };
}

const DELETE_INPUT = {
  actionId: "evt-100",
  kind: "file-delete",
  title: describeAction("file-delete", "/home/u/data.db"),
  detail: { target: "/home/u/data.db" },
};

describe("审批服务：纯函数", () => {
  it("动作指纹只由 kind + target 决定（升级计数口径稳定）", () => {
    expect(actionFingerprint("file-delete", "/a")).toBe(actionFingerprint("file-delete", "/a"));
    expect(actionFingerprint("file-delete", "/a")).not.toBe(actionFingerprint("file-write", "/a"));
    // 超长 target 截断，避免指纹无限膨胀。
    expect(actionFingerprint("shell-exec", "x".repeat(500)).length).toBeLessThan(220);
  });

  it("动作类型 → 人话标题：未知类型不臆测细节", () => {
    expect(describeAction("file-delete", "/a/b")).toContain("删除文件");
    expect(describeAction("message-send", "telegram")).toContain("对外发送消息");
    expect(describeAction("mystery-kind", "/a/b")).toContain("高危动作");
  });
});

describe("审批服务：决策链路", () => {
  it("请求 → 推送卡片（含 3 个按钮）→ 批准 → 审计 + 事件 + 归档", () => {
    const { service, trustEvents, posts, resolved, audit } = makeService({});
    const item = service.request(DELETE_INPUT);

    expect(item.status).toBe("pending");
    expect(item.escalateRequired).toBe(false);
    expect(item.attempts).toBe(1);
    expect(item.confirmUrl).toBe(`https://butler.example.com/approvals/${item.id}`);

    // 卡片：critical 级、3 个按钮、两个按钮走回调一个走链接。
    expect(posts.length).toBe(1);
    const card = posts[0]!;
    expect(card.severity).toBe("critical");
    expect(card.dedupeKey).toBe(`approval:${item.id}`);
    expect(card.actions?.map((action) => action.label)).toEqual(["批准一次", "拒绝", "查看详情"]);
    expect(card.actions?.[0]?.callbackData).toBe(`apr:${item.id}:approve`);
    expect(card.actions?.[2]?.url).toBe(item.confirmUrl);
    // 卡片正文交代「多久不管就按拒绝处理」，不让用户猜。
    expect(card.body).toContain("15 分钟");

    // 请求已留痕。
    expect(audit.list({ action: APPROVAL_REQUESTED_ACTION }).length).toBe(1);

    const outcome = service.decide(item.id, { decision: "approve", actor: "u1", channel: "telegram" });
    expect(outcome.ok).toBe(true);
    expect(outcome.item?.status).toBe("approved");
    expect(outcome.item?.actor).toBe("u1");
    expect(outcome.item?.channel).toBe("telegram");

    expect(audit.list({ action: APPROVAL_APPROVED_ACTION }).length).toBe(1);
    // 批准不生成拦截事件（拦截事件只给拒绝/超时）。
    expect(trustEvents.list({ severity: "warn" }).length).toBe(0);
    expect(resolved).toContain(`approval:${item.id}`);
  });

  it("拒绝 → 状态 denied + 拦截事件（warn）", () => {
    const { service, trustEvents, audit } = makeService();
    const item = service.request(DELETE_INPUT);
    const outcome = service.decide(item.id, { decision: "deny", actor: "u1", channel: "panel", reason: "不该删这个库" });

    expect(outcome.ok).toBe(true);
    expect(outcome.item?.status).toBe("denied");
    expect(audit.list({ action: APPROVAL_DENIED_ACTION }).length).toBe(1);

    const blocked = trustEvents.list({ severity: "warn" });
    expect(blocked.length).toBe(1);
    expect(blocked[0]?.kind).toBe(APPROVAL_BLOCKED_EVENT_KIND);
    expect(blocked[0]?.title).toContain("已拒绝");
  });

  it("重复决策只生效一次（并发下不产生第二份留痕）", () => {
    const { service, audit } = makeService();
    const item = service.request(DELETE_INPUT);
    expect(service.decide(item.id, { decision: "approve" }).ok).toBe(true);
    const second = service.decide(item.id, { decision: "deny" });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("already-settled");
    expect(second.item?.status).toBe("approved");
    expect(audit.list({ action: APPROVAL_DENIED_ACTION }).length).toBe(0);
  });

  it("未知 id → not-found", () => {
    const { service } = makeService();
    expect(service.decide("missing", { decision: "approve" })).toEqual({ ok: false, reason: "not-found" });
  });

  it("幂等：同一动作事件只开一张单，不重复推送与留痕", () => {
    const { service, store, posts, audit } = makeService();
    const first = service.request(DELETE_INPUT);
    const second = service.request(DELETE_INPUT);
    expect(second.id).toBe(first.id);
    expect(posts.length).toBe(1);
    expect(audit.list({ action: APPROVAL_REQUESTED_ACTION }).length).toBe(1);
    expect(store.countActionApprovals().total).toBe(1);
  });

  it("指纹去重：同 kind+target 的未决单挡住携带新 actionId 的重试风暴，跨阈值时原单升级", () => {
    // 客户反馈 B2：上游重试常生成新 actionId，仅按 actionId 去重挡不住；
    // 同指纹已有 pending 单时复用并推进 attempts，不再新开单/重复推卡。
    const { service, store, posts, audit } = makeService();
    const first = service.request(DELETE_INPUT);
    const retry = service.request({ ...DELETE_INPUT, actionId: "evt-100-retry" });

    expect(retry.id).toBe(first.id);
    expect(retry.attempts).toBe(2); // 复用单上累计，不重置
    expect(posts.length).toBe(1); // 未跨阈值不补发卡片
    expect(audit.list({ action: APPROVAL_REQUESTED_ACTION }).length).toBe(2); // 重试留痕（deduped 标记）

    // 结算后同指纹的新事件允许重新开单（不误伤合法新请求）；但升级窗口内的
    // 请求次数仍计入（本次窗口内序号 3 ——「拒了就重试」不能把升级计数洗回 1，
    // 否则第 3 次升级形同虚设）。
    expect(service.decide(first.id, { decision: "deny", actor: "u1" }).ok).toBe(true);
    const fresh = service.request({ ...DELETE_INPUT, actionId: "evt-100-after" });
    expect(fresh.id).not.toBe(first.id);
    // attempts 是「本单吸收的请求数」，新单从 1 开始；对外说的次数看 windowCount。
    expect(fresh.attempts).toBe(1);
    expect(fresh.windowCount).toBe(3);
    expect(fresh.escalateRequired).toBe(true);
    expect(store.countActionApprovals().total).toBe(2);
  });

  it("指纹去重下升级仍然可达：同一未决单第 3 次请求 → escalateRequired + 补发升级卡", () => {
    // M3.1 验收语义在新去重路径上的等价形态：第 3 次重试跨过阈值时，
    // 原单升级（内联按钮撤下，仅留面板入口）并补发一次升级卡。
    const { service, posts } = makeService();
    const first = service.request({ ...DELETE_INPUT, actionId: "evt-1" });
    expect(first.escalateRequired).toBe(false);

    const second = service.request({ ...DELETE_INPUT, actionId: "evt-2" });
    expect(second.id).toBe(first.id);
    expect(second.escalateRequired).toBe(false);

    const third = service.request({ ...DELETE_INPUT, actionId: "evt-3" });
    expect(third.id).toBe(first.id);
    expect(third.attempts).toBe(3);
    expect(third.escalateRequired).toBe(true);

    // 卡片：初始 1 张 + 跨阈值补发 1 张（共 2 张，不是每单 1 张的风暴形态）。
    expect(posts.length).toBe(2);
    const escalatedCard = posts[1]!;
    expect(escalatedCard.dedupeKey).toBe(`approval:${first.id}`);
    expect(escalatedCard.actions?.map((action) => action.label)).toEqual(["前往面板确认"]);
    expect(escalatedCard.body).toContain("需在面板确认");

    // 第 4 次重试：已升级，不再补发第三张卡。
    const fourth = service.request({ ...DELETE_INPUT, actionId: "evt-4" });
    expect(fourth.attempts).toBe(4);
    expect(fourth.escalateRequired).toBe(true);
    expect(posts.length).toBe(2);
  });
});

describe("审批服务：升级计数不虚高（多轮结算）", () => {
  it("4 轮「3 次请求 → 结算 → 再开单」：对外次数是 1…12，不是复合膨胀后的 45", () => {
    // 回归根因：attempts 一列曾同时表示「窗口内序号」与「本单吸收数」，
    // 配 SUM(attempts) 口径后每轮历史被反复计入（第 3/4 轮算出 10/11/12 与
    // 22/23/24）。客户在卡片和面板上看到的是这个数，必须是真的。
    const { service, store, trustEvents, posts, clock } = makeService();
    const observed: number[] = [];

    for (let round = 1; round <= 4; round += 1) {
      let openId = "";
      for (let i = 1; i <= 3; i += 1) {
        const item = service.request({ ...DELETE_INPUT, actionId: `evt-r${round}-${i}` });
        observed.push(item.windowCount);
        openId = item.id;
      }
      expect(service.decide(openId, { decision: "deny", actor: "u1" }).ok).toBe(true);
    }

    expect(observed).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    // 底层口径不变式：窗口内 SUM(attempts) 恒等于真实请求数。
    const since = new Date(clock.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(store.countApprovalRequestsByAction(actionFingerprint("file-delete", "/home/u/data.db"), since)).toBe(12);

    // 卡片与事件中心的「第 N 次」也是真数字（第 4 轮首单 = 第 10 次）。
    expect(posts[posts.length - 1]?.body).toContain("已被请求 10 次");
    expect(trustEvents.list({ limit: 50 }).map((event) => event.title).join("\n")).toContain("今日第 10 次");
  });
});

describe("审批服务：超时默认拒绝（验收硬指标）", () => {
  it("到期未应答 → expired + 拦截事件 + 审计 + 归档", () => {
    const { service, trustEvents, resolved, clock, audit } = makeService({ ttlMs: 60_000 });
    const item = service.request(DELETE_INPUT);
    expect(service.sweep()).toBe(0); // 未到期不动

    clock.advance(60_001);
    expect(service.sweep()).toBe(1);

    const settled = service.get(item.id)!;
    expect(settled.status).toBe("expired");
    expect(settled.actor).toBe("system:timeout");
    expect(settled.reason).toContain("默认拒绝");
    expect(settled.remainingMs).toBe(0);

    expect(audit.list({ action: APPROVAL_EXPIRED_ACTION }).length).toBe(1);
    expect(trustEvents.list({ severity: "warn" })[0]?.title).toContain("超时未应答");
    expect(resolved).toContain(`approval:${item.id}`);
  });

  it("踩在超时点上批准 → 一律按拒绝结算（不给「迟到的批准」开口子）", () => {
    const { service, clock } = makeService({ ttlMs: 60_000 });
    const item = service.request(DELETE_INPUT);
    clock.advance(60_000); // 恰好到期

    const outcome = service.decide(item.id, { decision: "approve" });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("expired");
    expect(outcome.item?.status).toBe("expired");
  });

  it("已结算的单不被 sweep 二次结算", () => {
    const { service, clock } = makeService({ ttlMs: 60_000 });
    const item = service.request(DELETE_INPUT);
    service.decide(item.id, { decision: "deny" });
    clock.advance(120_000);
    expect(service.sweep()).toBe(0);
    expect(service.get(item.id)?.status).toBe("denied");
  });
});

describe("审批服务：24h 内第 3 次升级", () => {
  it("同一动作指纹第 3 次请求 → escalateRequired，卡片改为「前往面板确认」", () => {
    const { service, posts } = makeService();
    // 指纹去重后升级语义落在同一张单上：前两次 pending 不升级，第三次
    // 复用单跨过阈值 → escalateRequired + 补发升级卡（详见 B2 用例）。
    const a = service.request({ ...DELETE_INPUT, actionId: "evt-1" });
    const b = service.request({ ...DELETE_INPUT, actionId: "evt-2" });
    const c = service.request({ ...DELETE_INPUT, actionId: "evt-3" });

    expect(a.escalateRequired).toBe(false);
    expect(b.escalateRequired).toBe(false);
    expect(c.escalateRequired).toBe(true);
    expect(c.attempts).toBe(3);

    // 初始卡 + 跨阈值补发的升级卡：升级卡只剩一个链接按钮。
    const escalatedCard = posts[1]!;
    expect(escalatedCard.actions?.map((action) => action.label)).toEqual(["前往面板确认"]);
    expect(escalatedCard.body).toContain("需在面板确认");
  });

  it("通道侧对已升级单批准被拒；面板侧放行成功", () => {
    const { service } = makeService();
    service.request({ ...DELETE_INPUT, actionId: "evt-1" });
    service.request({ ...DELETE_INPUT, actionId: "evt-2" });
    const third = service.request({ ...DELETE_INPUT, actionId: "evt-3" });

    // 通道侧（allowEscalatedInline 非 true）→ 拒绝放行。
    const viaChannel = service.decide(third.id, { decision: "approve", channel: "telegram" });
    expect(viaChannel.ok).toBe(false);
    expect(viaChannel.reason).toBe("requires-web-confirm");
    expect(service.get(third.id)?.status).toBe("pending"); // 状态未被改动

    // 通道侧拒绝仍然允许——拦比放安全。
    const denyViaChannel = service.decide(third.id, { decision: "deny", channel: "telegram" });
    expect(denyViaChannel.ok).toBe(true);
    expect(denyViaChannel.item?.status).toBe("denied");
  });

  it("面板侧可放行已升级单", () => {
    const { service } = makeService();
    service.request({ ...DELETE_INPUT, actionId: "evt-1" });
    service.request({ ...DELETE_INPUT, actionId: "evt-2" });
    const third = service.request({ ...DELETE_INPUT, actionId: "evt-3" });
    const outcome = service.decide(third.id, {
      decision: "approve",
      channel: "panel",
      actor: "panel-user",
      allowEscalatedInline: true,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.item?.status).toBe("approved");
  });

  it("超出升级窗口后计数重置（不会永久背着历史包袱）", () => {
    const { service, clock } = makeService({ escalationWindowMs: 60_000 });
    service.request({ ...DELETE_INPUT, actionId: "evt-1" });
    service.request({ ...DELETE_INPUT, actionId: "evt-2" });
    clock.advance(61_000); // 滑出窗口
    const later = service.request({ ...DELETE_INPUT, actionId: "evt-3" });
    expect(later.attempts).toBe(1);
    expect(later.escalateRequired).toBe(false);
  });
});

describe("审批服务：全部允许模式与批量批准", () => {
  it("全部允许模式：开单即自动批准、不推卡片，但审计与事件一条不少", () => {
    const { service, posts, audit, trustEvents } = makeService();
    expect(service.mode()).toBe("ask");
    expect(service.setMode("allow-all")).toBe("allow-all");

    const item = service.request(DELETE_INPUT);
    expect(item.status).toBe("approved");
    expect(item.actor).toBe("system:allow-all");
    expect(item.channel).toBe("policy");
    // 不打扰：一张卡片都不推。
    expect(posts.length).toBe(0);
    // 留痕不省：请求与批准两条审计都在，事件中心有自动放行记录。
    expect(audit.list({ action: APPROVAL_REQUESTED_ACTION }).length).toBe(1);
    expect(audit.list({ action: APPROVAL_APPROVED_ACTION }).length).toBe(1);
    const titles = trustEvents.list({}).map((event) => event.title);
    expect(titles.some((title) => title.includes("全部允许模式自动放行"))).toBe(true);
    // 自动放行的单不该再留「等待你确认」这种与终态矛盾的事件。
    expect(titles.some((title) => title.includes("等待你确认"))).toBe(false);

    // 切回逐条确认后恢复等待应答（模式是可逆的）。
    expect(service.setMode("ask")).toBe("ask");
    const pending = service.request({ ...DELETE_INPUT, actionId: "evt-ask-again" });
    expect(pending.status).toBe("pending");
    expect(posts.length).toBe(1);
  });

  it("全部允许模式：重试命中既有未决单也会被放行（不会卡成死单）", () => {
    const { service, posts } = makeService();
    // 先在逐条确认模式下留一张 pending 单，构成「重试命中」的前提。
    const first = service.request({ ...DELETE_INPUT, actionId: "evt-1" });
    expect(first.status).toBe("pending");
    expect(posts.length).toBe(1);

    service.setMode("allow-all");
    const retry = service.request({ ...DELETE_INPUT, actionId: "evt-2" });
    expect(retry.id).toBe(first.id); // 复用同一张单
    expect(retry.status).toBe("approved");
    expect(service.get(first.id)?.status).toBe("approved");
    expect(posts.length).toBe(1); // 放行路径不补发升级卡
  });

  it("批量批准：成功的批准、已结算与不存在的单计入 failed 且不抛异常", () => {
    const { service } = makeService();
    const a = service.request({ ...DELETE_INPUT, actionId: "evt-a" });
    const b = service.request({
      actionId: "evt-b",
      kind: "shell-exec",
      title: describeAction("shell-exec", "rm -rf /tmp/cache"),
      detail: { target: "rm -rf /tmp/cache" },
    });
    const c = service.request({
      actionId: "evt-c",
      kind: "api-call",
      title: describeAction("api-call", "https://example.com"),
      detail: { target: "https://example.com" },
    });
    expect(service.decide(c.id, { decision: "deny" }).ok).toBe(true);

    const result = service.bulkDecide({ ids: [a.id, b.id, c.id, "missing"], decision: "approve", actor: "u1" });
    expect(result.total).toBe(4);
    expect(result.succeeded).toBe(2);
    expect(result.failed.map((entry) => entry.id).sort()).toEqual([c.id, "missing"].sort());
    expect(result.failed.every((entry) => entry.reason !== "")).toBe(true);
    expect(service.get(a.id)?.status).toBe("approved");
    expect(service.get(b.id)?.status).toBe("approved");
    expect(service.get(c.id)?.status).toBe("denied"); // 已结算的不被翻案
  });

  it("批量批准 all:true 只作用于待处理单", () => {
    const { service } = makeService();
    const pending = service.request({ ...DELETE_INPUT, actionId: "evt-p" });
    const settled = service.request({
      actionId: "evt-s",
      kind: "shell-exec",
      title: describeAction("shell-exec", "sudo reboot"),
      detail: { target: "sudo reboot" },
    });
    expect(service.decide(settled.id, { decision: "deny" }).ok).toBe(true);

    const result = service.bulkDecide({ all: true, decision: "approve" });
    expect(result.total).toBe(1); // 库里只剩那一条 pending
    expect(result.succeeded).toBe(1);
    expect(result.failed.length).toBe(0);
    expect(service.get(pending.id)?.status).toBe("approved");
    expect(service.get(settled.id)?.status).toBe("denied");
  });

  it("批量批准可放行已升级单（面板发起即等于面板确认）", () => {
    const { service } = makeService();
    const first = service.request({ ...DELETE_INPUT, actionId: "evt-1" });
    service.request({ ...DELETE_INPUT, actionId: "evt-2" });
    const third = service.request({ ...DELETE_INPUT, actionId: "evt-3" });
    expect(third.escalateRequired).toBe(true);
    // 单条通道侧会被挡，批量（面板侧）应当放行。
    const result = service.bulkDecide({ ids: [third.id], decision: "approve" });
    expect(result.succeeded).toBe(1);
    expect(service.get(first.id)?.status).toBe("approved");
  });
});

describe("审批服务：高危动作增量侦测", () => {
  it("只处理 watermark 之后的新高危行；info 级动作不开单", () => {
    const { service, store } = makeService({ autoDetect: true });
    store.insertActionEvent({
      ts: new Date().toISOString(),
      kind: "file-write",
      severity: "info",
      target: "/home/u/out.json",
      parserVersion: "v1",
    });
    store.insertActionEvent({
      ts: new Date().toISOString(),
      kind: "shell-exec",
      severity: "high",
      target: "rm -rf /home/u/data",
      detail: { target: "rm -rf /home/u/data" },
      sessionId: "sess-1",
      parserVersion: "v1",
    });

    expect(service.scanHighRisk()).toBe(1);
    const listed = service.list({}).items;
    expect(listed.length).toBe(1);
    expect(listed[0]?.kind).toBe("shell-exec");
    expect(listed[0]?.sessionId).toBe("sess-1");

    // 水位推进后再扫不会重复开单。
    expect(service.scanHighRisk()).toBe(0);
    expect(store.countActionApprovals().total).toBe(1);

    // 新增一行 → 再扫才开新单。
    store.insertActionEvent({
      ts: new Date().toISOString(),
      kind: "file-delete",
      severity: "high",
      target: "/home/u/other.db",
      parserVersion: "v1",
    });
    expect(service.scanHighRisk()).toBe(1);
    expect(store.countActionApprovals().total).toBe(2);
  });

  it("autoDetect 关闭时侦测不产生任何单", () => {
    const { service, store } = makeService({ autoDetect: false });
    store.insertActionEvent({
      ts: new Date().toISOString(),
      kind: "shell-exec",
      severity: "high",
      target: "sudo rm -rf /",
      parserVersion: "v1",
    });
    expect(service.scanHighRisk()).toBe(0);
    expect(store.countActionApprovals().total).toBe(0);
  });
});

describe("审批服务：列表与统计", () => {
  it("summary 分状态计数 + escalateOnly 过滤", () => {
    const { service, audit } = makeService();
    void audit;
    // 中间单先结算，让 evt-4 能作为独立新单开出来（指纹去重后同指纹
    // pending 单会复用，见 B2 用例）。
    service.request({ ...DELETE_INPUT, actionId: "evt-1" });
    service.request({ ...DELETE_INPUT, actionId: "evt-2" });
    const third = service.request({ ...DELETE_INPUT, actionId: "evt-3" });
    service.request({ actionId: "evt-9", kind: "api-call", title: "调用外部接口", detail: { target: "https://x" } });

    service.decide(third.id, { decision: "deny" });

    const all = service.list({});
    // total/denied 按去重后的行数口径：evt-1/2/3 合并为 1 行（denied）+ evt-9 = 2 行。
    expect(all.summary.total).toBe(2);
    expect(all.summary.pending).toBe(1);
    expect(all.summary.denied).toBe(1);
    expect(all.summary.escalated).toBe(0); // 唯一升级单已结算（escalated 只计待办）

    // escalateOnly 是纯「是否升级过」标志，需与 status 组合表达「升级且待办」——
    // 这正是面板默认视图（status=pending & escalateOnly=1）的语义。
    expect(service.list({ escalateOnly: true, status: "pending" }).items.length).toBe(0);
    // 不带 status 时，已结算的升级单仍会出现（可按状态二次筛选）。
    expect(service.list({ escalateOnly: true }).items.length).toBe(1);

    const fourth = service.request({ ...DELETE_INPUT, actionId: "evt-4" }); // 结算后新单（第 4 次窗口内请求）
    expect(fourth.escalateRequired).toBe(true); // SUM(attempts)=3 已含前 3 次 → 本次序号 4
    const nowEscalated = service.list({ escalateOnly: true, status: "pending" });
    expect(nowEscalated.items.length).toBe(1);
    expect(nowEscalated.summary.escalated).toBe(1);
  });

  it("prune 按保留期清理旧单", () => {
    const { service, store, clock } = makeService()
    service.request(DELETE_INPUT);
    expect(store.countActionApprovals().total).toBe(1);
    clock.advance(31 * 24 * 60 * 60 * 1000); // 越过默认 30 天保留期
    expect(service.prune()).toBe(1);
    expect(store.countActionApprovals().total).toBe(0);
  });
});

describe("审批 HTTP 端点", () => {
  let http: WatchHttp;
  let base: string;
  let cleanup: (() => void) | null = null;

  const boot = async (withApprovals = true, ttlMs = 60_000) => {
    const { service, clock, store } = makeService({ ttlMs });
    const deps: WatchHttpDeps = {
      scheduler: {
        runNow: () => true,
        status: () => ({ lastAt: null, nextAt: null, intervalMin: 5, inFlight: false }),
      },
      runbooks: () => [],
      executeRunbook: async () => ({ status: "started", instanceId: "hermes-a" }),
      upgrade: upgradeStub,
      gateway: gatewayStub,
      ...(withApprovals ? { approvals: service } : {}),
    };
    cleanup = () => store.close();
    http = startWatchHttp(deps, { port: 0 });
    const addr = await http.start();
    base = `http://127.0.0.1:${addr.port}`;
    return { service, clock };
  };

  afterEach(() => {
    http?.close();
    cleanup?.();
    cleanup = null;
  });

  it("POST /api/approvals → 201（缺字段 → 400）", async () => {
    await boot();
    const created = await fetch(`${base}/api/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actionId: "evt-1", kind: "file-delete", title: "删除文件" }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { item: { id: string; status: string } };
    expect(body.item.status).toBe("pending");

    const bad = await fetch(`${base}/api/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "file-delete" }),
    });
    expect(bad.status).toBe(400);
  });

  it("GET /api/approvals → items + summary + scan", async () => {
    const { service } = await boot();
    service.request(DELETE_INPUT);
    const res = await fetch(`${base}/api/approvals?status=pending&limit=10`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string }>;
      summary: { pending: number };
      scan: { ttlMs: number; escalationThreshold: number };
    };
    expect(body.items.length).toBe(1);
    expect(body.summary.pending).toBe(1);
    expect(body.scan.ttlMs).toBe(60_000);
    expect(body.scan.escalationThreshold).toBe(3);
  });

  it("GET /api/approvals/:id → 200 / 未知 id → 404", async () => {
    const { service } = await boot();
    const item = service.request(DELETE_INPUT);
    const found = await fetch(`${base}/api/approvals/${item.id}`);
    expect(found.status).toBe(200);
    expect(((await found.json()) as { item: { id: string } }).item.id).toBe(item.id);

    const missing = await fetch(`${base}/api/approvals/nope`);
    expect(missing.status).toBe(404);
  });

  it("POST /api/approvals/:id/decide → 200；非法 decision → 400；重复 → 409", async () => {
    const { service } = await boot();
    const item = service.request(DELETE_INPUT);

    const bad = await fetch(`${base}/api/approvals/${item.id}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "maybe" }),
    });
    expect(bad.status).toBe(400);

    const ok = await fetch(`${base}/api/approvals/${item.id}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", source: "panel" }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { item: { status: string } }).item.status).toBe("approved");

    const again = await fetch(`${base}/api/approvals/${item.id}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "deny" }),
    });
    expect(again.status).toBe(409);
  });

  it("超时后 decide → 410 expired；已升级单通道侧 → 409 requires-web-confirm", async () => {
    // 超时路径：推时钟越过 TTL，再走 HTTP 决策应得 410。
    const { service, clock } = await boot(true, 30_000);
    const single = service.request(DELETE_INPUT);
    clock.advance(30_001);
    const timedOut = await fetch(`${base}/api/approvals/${single.id}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", source: "panel" }),
    });
    expect(timedOut.status).toBe(410);
    const timedOutBody = (await timedOut.json()) as { error: string; item: { status: string } };
    expect(timedOutBody.error).toBe("expired");
    expect(timedOutBody.item.status).toBe("expired");

    // 升级单：同一指纹第三次 → 通道侧放行被拒（B2 去重后升级落在复用单上）。
    const { service: service2 } = await boot(true, 30_000);
    service2.request({ ...DELETE_INPUT, actionId: "e1" });
    service2.request({ ...DELETE_INPUT, actionId: "e2" });
    const third = service2.request({ ...DELETE_INPUT, actionId: "e3" });
    expect(third.escalateRequired).toBe(true);
    const escalated = await fetch(`${base}/api/approvals/${third.id}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", source: "channel" }),
    });
    expect(escalated.status).toBe(409);
    expect(((await escalated.json()) as { error: string }).error).toBe("requires-web-confirm");
  });

  it("未接线 approvals → 503", async () => {
    await boot(false);
    const res = await fetch(`${base}/api/approvals`);
    expect(res.status).toBe(503);
    const decide = await fetch(`${base}/api/approvals/x/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(decide.status).toBe(503);
  });

  it("PUT /api/approvals/mode → 200；非法值 → 400；列表接口同时回传 mode", async () => {
    await boot();
    const bad = await fetch(`${base}/api/approvals/mode`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "yolo" }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid-approval-mode");

    const ok = await fetch(`${base}/api/approvals/mode`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "allow-all" }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { mode: string }).mode).toBe("allow-all");

    // 面板一次请求即可同时拿到列表与模式。
    const listed = await fetch(`${base}/api/approvals?status=pending&limit=1`);
    expect(((await listed.json()) as { mode: string }).mode).toBe("allow-all");
  });

  it("POST /api/approvals/bulk-decide → 200；非法 decision → 400", async () => {
    const { service } = await boot();
    service.request(DELETE_INPUT);

    const bad = await fetch(`${base}/api/approvals/bulk-decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "maybe" }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid-bulk-decision");

    const ok = await fetch(`${base}/api/approvals/bulk-decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true, decision: "approve" }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { total: number; succeeded: number; failed: unknown[] };
    expect(body.total).toBe(1);
    expect(body.succeeded).toBe(1);
    expect(body.failed.length).toBe(0);
  });

  it("GET /api/approvals/decide-like-path 不会误伤列表路由（method-not-allowed）", async () => {
    await boot();
    const res = await fetch(`${base}/api/approvals`, { method: "PUT" });
    expect(res.status).toBe(405);
  });
});
