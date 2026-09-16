import { describe, expect, it, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "antd";
import { MemoryRouter } from "react-router-dom";
import { AdvancedEvidence } from "../src/components/AdvancedEvidence.js";
import { IssueCard } from "../src/components/IssueCard.js";
import { TaskDefaultsPanel } from "../src/pages/settings/TaskDefaultsPanel.js";
import { readScheduledTaskDefaults } from "../src/pages/settings/taskDefaults.js";
import {
  SETTINGS_CATEGORIES,
  resolveCategoryKey,
  settingsToolPaths,
} from "../src/pages/settings/categories.js";
import {
  ACTIONABLE_MESSAGE_STATES,
  actionableApprovals,
  loadMessageOverview,
  messageSummary,
} from "../src/pages/gateway/attention.js";
import { MessageDetail, MessageInspector } from "../src/pages/gateway/MessageInspector.js";
import { AlertQueuePanel } from "../src/pages/gateway/AlertQueuePanel.js";
import type { MessageItemView, MessageOverviewPayload } from "../src/pages/gateway/helpers.js";
import { SettingsPage } from "../src/pages/settings/SettingsPage.js";
import { ThemeProvider } from "../src/theme/ThemeProvider.js";

function item(state: string, id = state): MessageItemView {
  return {
    messageId: id,
    instanceId: "hermes",
    adapterId: "hermes",
    channel: "weixin",
    chatId: "chat",
    sessionId: "session",
    messageKind: "final",
    transport: "queued-push",
    priority: "normal",
    content: "摘要".repeat(150) + "完整消息尾部",
    metadata: {},
    capturedAt: "2026-09-15T00:00:00Z",
    sequence: 1,
    state,
    availableAt: null,
    attemptCount: 0,
    providerMessageId: null,
    deliveredAt: null,
    lastError: "SQLITE_BUSY /private/logs",
    transformTrace: [],
    lastPolicyError: null,
    updatedAt: new Date().toISOString(),
  };
}

const payload = (items: MessageItemView[]): MessageOverviewPayload => ({
  reachable: true,
  status: null,
  messages: { counts: { delivered: 1000, dead_letter: 1, delivery_unknown: 1 }, items },
  degraded: [],
});

afterEach(() => vi.unstubAllGlobals());

describe("actionable messages are selected before the history limit", () => {
  it("queries each actionable state independently even with 1000 delivered records", async () => {
    const fetch = vi.fn(async (url: string) => {
      const state = new URL(url, "http://local").searchParams.get("state");
      return payload(
        state
          ? [
              item(state),
              ...Array.from({ length: 1000 }, (_, index) => item("delivered", String(index))),
            ]
          : [],
      );
    });
    const result = await loadMessageOverview(fetch, true, "all");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result?.messages.items.map((message) => message.state).sort()).toEqual(
      [...ACTIONABLE_MESSAGE_STATES].sort(),
    );
    for (const state of ACTIONABLE_MESSAGE_STATES)
      expect(fetch).toHaveBeenCalledWith(`/api/messages/overview?limit=60&state=${state}`);
  });

  it("does not present a partial state fetch as a successful empty inbox", async () => {
    const result = await loadMessageOverview(
      async (url) => (url.includes("delivery_unknown") ? null : payload([])),
      true,
      "all",
    );
    expect(result).toBeNull();
  });

  it("keeps delivered history available and propagates degraded state", async () => {
    const fetch = vi.fn(async () => ({
      ...payload([item("delivered")]),
      reachable: false,
      degraded: ["bridge"],
    }));
    const result = await loadMessageOverview(fetch, false, "delivered");
    expect(fetch).toHaveBeenCalledWith("/api/messages/overview?limit=60&state=delivered");
    expect(result?.messages.items[0].state).toBe("delivered");
    expect(result?.reachable).toBe(false);
    expect(result?.degraded).toEqual(["bridge"]);
  });

  it("includes only pending, non-expired approvals and user confirmations", () => {
    const base = {
      id: "approval",
      title: "待确认",
      kind: "message-send",
      status: "pending",
      remainingMs: 100,
      escalateRequired: true,
    };
    expect(
      actionableApprovals([
        base,
        { ...base, id: "done", status: "approved" },
        { ...base, id: "expired", remainingMs: 0 },
      ]),
    ).toEqual([base]);
  });
});

describe("progressive message detail and evidence", () => {
  it("summarizes whitespace and long bodies without changing the full detail", () => {
    expect(messageSummary("a \n b")).toBe("a b");
    const message = item("delivery_unknown");
    expect(messageSummary(message.content)).not.toContain("完整消息尾部");
    const html = renderToStaticMarkup(
      <MessageDetail
        message={message}
        taskData={null}
        taskLoading={false}
        onRedeliver={() => undefined}
      />,
    );
    expect(html).toContain("完整消息尾部");
    expect(html).toContain("请勿重复发送");
    expect(html).not.toContain("重新投递");
    expect(html).not.toContain("SQLITE_BUSY");
  });

  it("default list excludes delivered records and full body until detail is opened", () => {
    const html = renderToStaticMarkup(
      <MessageInspector
        messageBridge={null}
        coverageEntries={[]}
        messageCounts={{ delivered: 1000 }}
        messageItems={[item("delivered"), item("dead_letter")]}
        messagesReachable
        selectedMessage={null}
        onSelectMessage={() => undefined}
        taskData={null}
        taskLoading={false}
        pendingOnly
      />,
    );
    expect(html).not.toContain("已送达");
    expect(html).not.toContain("完整消息尾部");
    expect(html).toContain("发送失败");
    expect(html).not.toContain("消息链路与覆盖");
  });

  it("folds stale actionable messages (>24h) into older records count by default", () => {
    const oldItem = {
      ...item("delivery_unknown", "old-1"),
      updatedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
    };
    const defaultHtml = renderToStaticMarkup(
      <MessageInspector
        messageBridge={null}
        coverageEntries={[]}
        messageCounts={{ delivery_unknown: 1 }}
        messageItems={[oldItem]}
        messagesReachable
        selectedMessage={null}
        onSelectMessage={() => undefined}
        taskData={null}
        taskLoading={false}
        pendingOnly
      />,
    );
    expect(defaultHtml).toContain("已收纳 1 条更早记录");
    expect(defaultHtml).not.toContain("结果未知");

    const allHtml = renderToStaticMarkup(
      <MessageInspector
        messageBridge={null}
        coverageEntries={[]}
        messageCounts={{ delivery_unknown: 1 }}
        messageItems={[oldItem]}
        messagesReachable
        selectedMessage={null}
        onSelectMessage={() => undefined}
        taskData={null}
        taskLoading={false}
        pendingOnly
        defaultTimeFilter="all"
      />,
    );
    expect(allHtml).toContain("结果未知");
  });

  it("does not hide a known failed notification behind a false empty conclusion", () => {
    const html = renderToStaticMarkup(
      <AlertQueuePanel
        alerts={{
          reachable: true,
          counts: { delivered: 1000, failed: 3 },
          degradedChannels: [],
          items: [],
        }}
      />,
    );
    expect(html).toContain("有 3 条失败通知");
    expect(html).not.toContain("没有发送失败的通知");
  });

  it("evidence starts closed and an issue exposes impact, action, risk and verification", () => {
    const html = renderToStaticMarkup(
      <IssueCard
        title="消息失败"
        impact="未能送达"
        suggestion="检查通道"
        risk="可能重复发送"
        verification="核实接收记录"
        evidence="RAW_DIAGNOSTIC"
      />,
    );
    for (const text of ["消息失败", "影响什么", "建议动作", "操作风险", "如何验证"])
      expect(html).toContain(text);
    expect(html).not.toContain("RAW_DIAGNOSTIC");
    expect(renderToStaticMarkup(<AdvancedEvidence>RAW_LOG</AdvancedEvidence>)).not.toContain(
      "RAW_LOG",
    );
  });
});

describe("settings migration and task defaults", () => {
  it("has five groups and preserves historical settings query aliases", () => {
    expect(SETTINGS_CATEGORIES.map((category) => category.key)).toEqual([
      "security",
      "tasks",
      "backups",
      "llm",
      "advanced",
    ]);
    expect(resolveCategoryKey("about")).toBe("backups");
    expect(resolveCategoryKey("preferences")).toBe("llm");
    expect(resolveCategoryKey("diagnostics")).toBe("advanced");
    expect(resolveCategoryKey("invalid")).toBe("security");
  });

  it("expert links are opt-in and federation requires two known instances", () => {
    for (const count of [null, 0, 1])
      expect(settingsToolPaths(false, count).expert).not.toContain("/federation");
    expect(settingsToolPaths(false, 2).expert).toContain("/federation");
    expect(settingsToolPaths(false, 3).expert).not.toContain("/evolution");
    expect(settingsToolPaths(true, 2).expert).toContain("/evolution");
    const tools = settingsToolPaths(true, 2);
    expect([...tools.expert, ...tools.reports]).toEqual(
      expect.arrayContaining([
        "/logs",
        "/setup",
        "/core-files",
        "/sessions",
        "/approvals",
        "/canary",
        "/cost",
      ]),
    );
  });

  it("legacy about query actually opens version content", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <App>
          <MemoryRouter initialEntries={["/settings?tab=about"]}>
            <SettingsPage />
          </MemoryRouter>
        </App>
      </ThemeProvider>,
    );
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("版本与升级");
  });

  it("ignores stored timezone and falls back safely when browser storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ timezone: "Arbitrary/Unsupported", deliveryEnabled: true }),
    });
    expect(readScheduledTaskDefaults()).toEqual({ deliveryEnabled: true });
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readScheduledTaskDefaults()).toEqual({ deliveryEnabled: false });
  });

  it("rejects corrupt notification defaults", () => {
    vi.stubGlobal("localStorage", { getItem: () => '{"deliveryEnabled":"true"}' });
    expect(readScheduledTaskDefaults()).toEqual({ deliveryEnabled: false });
  });

  it("timezone is read-only; notification is the only saved form control", () => {
    const html = renderToStaticMarkup(
      <App>
        <TaskDefaultsPanel />
      </App>,
    );
    expect(html).toContain("调度时区");
    expect(html).not.toContain('name="timezone"');
    expect(html).not.toContain("Asia/Shanghai");
    expect(html).toContain('role="switch"');
  });
});
