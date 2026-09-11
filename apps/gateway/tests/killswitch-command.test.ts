/**
 * M1.3 通道口令急停 + M3.1 交互卡片 的网关侧测试：
 *
 * M1.3：口令解析是唯一「远程停掉全部实例」的入口，必须保守——
 *   口令未配置/过短 → 功能整体关闭；必须完整出现；只认显式动词。
 * M3.1：告警按钮校验（≤3 项、label 必填、url 或 callbackData 至少一个）+
 *   内联按钮渲染 + 不支持内联按钮的通道降级为正文链接 + webhook 回执桥接。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGatewayServer,
  parseKillswitchCommand,
  parseApprovalCallback,
  createWatchApprovalDecider,
  createWatchKillswitchCommander,
  type GatewayApp,
} from "../src/server";
import { AlertQueue, type AlertAction } from "../src/queue";
import { buildEnvChannels, TelegramChannel, ServerChanChannel } from "../src/channels";
import { gatewayDbFile, makeTempDir, rmTempDir } from "./helpers";

const PASSPHRASE = "butler-guard-2026";

describe("M1.3 口令急停：指令解析（安全优先）", () => {
  it("口令未配置或过短 → 功能整体关闭（任意文本都不构成指令）", () => {
    expect(parseKillswitchCommand("急停", "")).toBeNull();
    expect(parseKillswitchCommand(`${PASSPHRASE} 急停`, "")).toBeNull();
    expect(parseKillswitchCommand("abc 急停", "abc")).toBeNull(); // 长度 < 6
    expect(parseKillswitchCommand("", PASSPHRASE)).toBeNull();
  });

  it("口令必须完整出现：缺口令 / 错口令一律忽略", () => {
    expect(parseKillswitchCommand("急停", PASSPHRASE)).toBeNull();
    expect(parseKillswitchCommand("butler-guard-2027 急停", PASSPHRASE)).toBeNull();
    // 前缀也不算（必须完整片段）。
    expect(parseKillswitchCommand("butler-guard 急停", PASSPHRASE)).toBeNull();
  });

  it("只认显式动词；无动词或语义不明一律忽略", () => {
    expect(parseKillswitchCommand(`${PASSPHRASE} 急停`, PASSPHRASE)).toEqual({ command: "engage" });
    expect(parseKillswitchCommand(`${PASSPHRASE} emergency stop`, PASSPHRASE)).toEqual({ command: "engage" });
    expect(parseKillswitchCommand(`${PASSPHRASE} 恢复`, PASSPHRASE)).toEqual({ command: "release" });
    expect(parseKillswitchCommand(`${PASSPHRASE} resume`, PASSPHRASE)).toEqual({ command: "release" });
    expect(parseKillswitchCommand(`${PASSPHRASE} 状态`, PASSPHRASE)).toEqual({ command: "status" });
    // 只发口令不给动词：不猜用户想干什么。
    expect(parseKillswitchCommand(PASSPHRASE, PASSPHRASE)).toBeNull();
    expect(parseKillswitchCommand(`${PASSPHRASE} 随便改改配置`, PASSPHRASE)).toBeNull();
  });

  it("恢复优先于急停判定（避免词表扩展后误判）", () => {
    expect(parseKillswitchCommand(`${PASSPHRASE} 恢复运行`, PASSPHRASE)).toEqual({ command: "release" });
  });
});

describe("M1.3 急停转发端口", () => {
  const okJson = (payload: unknown): { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> } => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });

  it("engage → POST /api/killswitch/engage（带 trigger=channel-command 与 actor）", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const commander = createWatchKillswitchCommander({
      watchUrl: "http://watch:7533",
      fetchFn: (async (url: string, init: { body?: string }) => {
        calls.push({ url, body: init.body === undefined ? null : JSON.parse(init.body) });
        return okJson({ engaged: true });
      }) as never,
    });
    const result = await commander({ command: "engage", channel: "telegram", actor: "telegram:jiach" });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("已急停");
    expect(calls[0]?.url).toBe("http://watch:7533/api/killswitch/engage");
    expect(calls[0]?.body).toEqual({ trigger: "channel-command", actor: "telegram:jiach" });
  });

  it("status → 汇报当前是否已急停", async () => {
    const commander = createWatchKillswitchCommander({
      watchUrl: "http://watch:7533",
      fetchFn: (async () => okJson({ engaged: true, engagedAt: "2026-09-11T12:00:00.000Z" })) as never,
    });
    const result = await commander({ command: "status", channel: "telegram" });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("已急停");
  });

  it("409 already-engaged 映射为可读提示（不当作故障）", async () => {
    const commander = createWatchKillswitchCommander({
      watchUrl: "http://watch:7533",
      fetchFn: (async () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: "killswitch-already-engaged" }),
        text: async () => "{}",
      })) as never,
    });
    const result = await commander({ command: "engage", channel: "telegram" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("already-engaged");
    expect(result.message).toContain("已经是急停状态");
  });

  it("网络异常 → 明确告知指令未送达（不谎报成功）", async () => {
    const commander = createWatchKillswitchCommander({
      watchUrl: "http://watch:7533",
      fetchFn: (async () => {
        throw new Error("ECONNREFUSED");
      }) as never,
    });
    const result = await commander({ command: "engage", channel: "telegram" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("未送达");
  });
});

describe("M3.1 审批回执端口", () => {
  it("callback_data 只认 apr:<id>:<decision>", () => {
    expect(parseApprovalCallback("apr:ap-1:approve")).toEqual({ approvalId: "ap-1", decision: "approve" });
    expect(parseApprovalCallback("apr:ap-1:deny")).toEqual({ approvalId: "ap-1", decision: "deny" });
    expect(parseApprovalCallback("apr:ap-1:maybe")).toBeNull();
    expect(parseApprovalCallback("other:ap-1:approve")).toBeNull();
    expect(parseApprovalCallback("")).toBeNull();
  });

  it("决策转发带 source=channel（服务端据此拒绝放行升级单）", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const decider = createWatchApprovalDecider({
      watchUrl: "http://watch:7533",
      fetchFn: (async (url: string, init: { body?: string }) => {
        captured = { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
        return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
      }) as never,
    });
    const result = await decider({ approvalId: "ap-1", decision: "approve", channel: "telegram", actor: "telegram:u" });
    expect(result.ok).toBe(true);
    expect(captured!.url).toBe("http://watch:7533/api/approvals/ap-1/decide");
    expect(captured!.body["source"]).toBe("channel");
    expect(captured!.body["decision"]).toBe("approve");
  });

  it("409 映射为「已被处理或已升级」而非系统错误", async () => {
    const decider = createWatchApprovalDecider({
      watchUrl: "http://watch:7533",
      fetchFn: (async () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: "requires-web-confirm" }),
        text: async () => "{}",
      })) as never,
    });
    const result = await decider({ approvalId: "ap-1", decision: "approve", channel: "telegram" });
    expect(result.reason).toBe("already-settled");
    expect(result.message).toContain("面板");
  });
});

describe("M3.1 交互卡片：告警按钮契约", () => {
  let tmp: string;
  let queue: AlertQueue;
  let app: GatewayApp;

  beforeEach(() => {
    tmp = makeTempDir();
    queue = new AlertQueue(gatewayDbFile(tmp));
    app = createGatewayServer({ queue, channels: [], startLoop: false });
  });
  afterEach(async () => {
    await app.close();
    queue.close();
    rmTempDir(tmp);
  });

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/alerts", payload });

  it("合法 actions 入队并可从列表读回", async () => {
    const actions: AlertAction[] = [
      { label: "批准一次", callbackData: "apr:ap-1:approve" },
      { label: "拒绝", callbackData: "apr:ap-1:deny" },
      { label: "查看详情", url: "https://butler.example.com/approvals/ap-1" },
    ];
    const res = await post({
      kind: "action-approval",
      severity: "critical",
      title: "删除文件",
      body: "15 分钟未处理按拒绝拦截",
      source: "butler-watch",
      dedupeKey: "approval:ap-1",
      actions,
    });
    expect(res.statusCode).toBe(202);

    const list = await app.inject({ method: "GET", url: "/api/alerts" });
    const body = JSON.parse(list.body) as { items: Array<{ actions: AlertAction[] }> };
    expect(body.items[0]?.actions).toEqual(actions);
  });

  it("超 3 个按钮 / 缺 label / 两个字段都空 → 400", async () => {
    const base = { kind: "k", severity: "warn", title: "t", body: "b", source: "s" };
    const tooMany = await post({
      ...base,
      actions: [1, 2, 3, 4].map((n) => ({ label: `b${n}`, callbackData: `c${n}` })),
    });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.body).toContain("最多 3 个");

    const noLabel = await post({ ...base, actions: [{ callbackData: "c" }] });
    expect(noLabel.statusCode).toBe(400);

    const dead = await post({ ...base, actions: [{ label: "点了没反应" }] });
    expect(dead.statusCode).toBe(400);
    expect(dead.body).toContain("url 或 callbackData");
  });

  it("actions 非数组 → 400", async () => {
    const res = await post({ kind: "k", severity: "warn", title: "t", body: "b", source: "s", actions: "nope" });
    expect(res.statusCode).toBe(400);
  });

  it("无 actions 的旧报文形态保持兼容（actions 为空数组）", async () => {
    const res = await post({ kind: "k", severity: "warn", title: "t", body: "b", source: "s" });
    expect(res.statusCode).toBe(202);
    const list = await app.inject({ method: "GET", url: "/api/alerts" });
    const body = JSON.parse(list.body) as { items: Array<{ actions: unknown[] }> };
    expect(body.items[0]?.actions).toEqual([]);
  });
});

describe("M3.1 通道渲染与降级", () => {
  const ACTION_URL = "https://butler.example.com/approvals/ap-1";

  it("Telegram：callbackData → inline_keyboard；url → 内联 url 按钮；正文不重复贴链接", async () => {
    const bodies: string[] = [];
    const channel = new TelegramChannel({
      env: { BUTLER_TELEGRAM_BOT_TOKEN: "t", BUTLER_TELEGRAM_CHAT_ID: "c" },
      fetchImpl: (async (_url: string, init: { body: string }) => {
        bodies.push(init.body);
        return { ok: true, status: 200, text: async () => "{}" };
      }) as never,
    });
    await channel.send({
      severity: "critical",
      title: "删除文件",
      body: "15 分钟",
      source: "butler-watch",
      actions: [
        { label: "批准一次", callbackData: "apr:ap-1:approve" },
        { label: "查看详情", url: ACTION_URL },
      ],
    });
    const form = new URLSearchParams(bodies[0]!);
    const markup = JSON.parse(form.get("reply_markup")!) as {
      inline_keyboard: Array<Array<Record<string, string>>>;
    };
    expect(markup.inline_keyboard[0]?.[0]).toEqual({ text: "批准一次", callback_data: "apr:ap-1:approve" });
    expect(markup.inline_keyboard[1]?.[0]).toEqual({ text: "查看详情", url: ACTION_URL });
    // 有真按钮就不必在正文里再贴一遍。
    expect(form.get("text")).not.toContain(ACTION_URL);
  });

  it("相对路径 URL 不外发：正文与键盘都过滤掉（基址未配置时不产生打不开的链接）", async () => {
    const bodies: string[] = [];
    const channel = new TelegramChannel({
      env: { BUTLER_TELEGRAM_BOT_TOKEN: "t", BUTLER_TELEGRAM_CHAT_ID: "c" },
      fetchImpl: (async (_url: string, init: { body: string }) => {
        bodies.push(init.body);
        return { ok: true, status: 200, text: async () => "{}" };
      }) as never,
    });
    await channel.send({
      severity: "critical",
      title: "删除文件",
      body: "15 分钟",
      source: "butler-watch",
      actions: [
        { label: "批准一次", callbackData: "apr:ap-1:approve" },
        { label: "查看详情", url: "/approvals/ap-1" }, // 相对路径——不应外发
      ],
    });
    const form = new URLSearchParams(bodies[0]!);
    expect(form.get("text")).not.toContain("/approvals/ap-1");
    const markup = JSON.parse(form.get("reply_markup")!) as {
      inline_keyboard: Array<Array<Record<string, string>>>;
    };
    // 只有回调按钮；相对 url 按钮被过滤。
    expect(markup.inline_keyboard.length).toBe(1);
    expect(markup.inline_keyboard[0]?.[0]?.callback_data).toBe("apr:ap-1:approve");
  });

  it("Server酱（不支持内联按钮）：降级为正文追加链接", async () => {
    const bodies: string[] = [];
    const channel = new ServerChanChannel({
      env: { BUTLER_SERVERCHAN_SENDKEY: "k" },
      fetchImpl: (async (_url: string, init: { body: string }) => {
        bodies.push(init.body);
        return { ok: true, status: 200, text: async () => "{}" };
      }) as never,
    });
    await channel.send({
      severity: "critical",
      title: "删除文件",
      body: "15 分钟",
      source: "butler-watch",
      actions: [
        { label: "批准一次", callbackData: "apr:ap-1:approve" },
        { label: "查看详情", url: ACTION_URL },
      ],
    });
    const form = new URLSearchParams(bodies[0]!);
    const desp = form.get("desp")!;
    expect(desp).toContain(ACTION_URL);
    // 只有回调的按钮无链接可降级，不应出现「批准一次」的死链接行。
    expect(desp).not.toContain("· 批准一次");
  });

  it("env 通道序列与可用性判定不被本次改动影响", () => {
    const channels = buildEnvChannels({});
    expect(channels.map((channel) => channel.name)).toEqual(["telegram", "bark", "serverchan", "smtp"]);
    expect(channels.every((channel) => !channel.isConfigured())).toBe(true);
  });
});

describe("webhook：口令急停与审批回执", () => {
  let tmp: string;
  let queue: AlertQueue;
  let app: GatewayApp;
  let killed: string[] = [];
  let decided: string[] = [];

  beforeEach(() => {
    tmp = makeTempDir();
    queue = new AlertQueue(gatewayDbFile(tmp));
    killed = [];
    decided = [];
    app = createGatewayServer({
      queue,
      channels: [],
      startLoop: false,
      telegramWebhookSecret: "hook-secret",
      killswitchPassphrase: PASSPHRASE,
      killswitchCommander: async (input) => {
        killed.push(`${input.command}:${input.actor ?? "-"}`);
        return { ok: true, message: `已处理 ${input.command}` };
      },
      approvalDecider: async (input) => {
        decided.push(`${input.approvalId}:${input.decision}`);
        return { ok: true, message: "已批准本次操作" };
      },
    });
  });
  afterEach(async () => {
    await app.close();
    queue.close();
    rmTempDir(tmp);
  });

  const hook = (payload: unknown, secret = "hook-secret") =>
    app.inject({
      method: "POST",
      url: "/api/channels/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": secret },
      payload,
    });

  it("密钥错误 → 401（不解析内容）", async () => {
    const res = await hook({ message: { text: `${PASSPHRASE} 急停` } }, "wrong");
    expect(res.statusCode).toBe(401);
    expect(killed.length).toBe(0);
  });

  it("口令急停指令 → 桥接到 commander", async () => {
    const res = await hook({
      message: { text: `${PASSPHRASE} 急停`, from: { username: "jiach" }, chat: { id: 42 } },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).command).toBe("engage");
    expect(killed).toEqual(["engage:telegram:jiach"]);
  });

  it("普通消息 → 忽略（不触发任何动作）", async () => {
    const res = await hook({ message: { text: "今天天气不错", chat: { id: 42 } } });
    expect(JSON.parse(res.body).ignored).toBe("not-a-command");
    expect(killed.length).toBe(0);
  });

  it("内联按钮回执 → 桥接到 decider", async () => {
    const res = await hook({
      callback_query: { id: "cb-1", data: "apr:ap-9:deny", from: { id: 7 } },
    });
    expect(res.statusCode).toBe(200);
    expect(decided).toEqual(["ap-9:deny"]);
  });

  it("无法识别的 callback_data → 忽略且仍返回 200（避免 Telegram 重投）", async () => {
    const res = await hook({ callback_query: { id: "cb-2", data: "unknown" } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ignored).toBe("unrecognized-callback-data");
    expect(decided.length).toBe(0);
  });

  it("不支持的 update 类型 → 200 ignored", async () => {
    const res = await hook({ edited_message: { text: "x" } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ignored).toBe("unsupported-update");
  });

  it("会话白名单从注入配置读取（与 env 解耦）：非白名单会话被拒", async () => {
    const strictApp = createGatewayServer({
      queue,
      channels: [],
      startLoop: false,
      killswitchPassphrase: PASSPHRASE,
      killswitchAllowedChat: "424242",
      killswitchCommander: async (input) => {
        killed.push(input.command);
        return { ok: true, message: "ok" };
      },
    });
    const denied = await strictApp.inject({
      method: "POST",
      url: "/api/channels/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "hook-secret" },
      payload: { message: { text: `${PASSPHRASE} 急停`, from: { id: 1 }, chat: { id: 999 } } },
    });
    expect(JSON.parse(denied.body).reason).toBe("chat-not-allowed");
    expect(killed.length).toBe(0);

    const allowed = await strictApp.inject({
      method: "POST",
      url: "/api/channels/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "hook-secret" },
      payload: { message: { text: `${PASSPHRASE} 急停`, from: { id: 1 }, chat: { id: 424242 } } },
    });
    expect(JSON.parse(allowed.body).command).toBe("engage");
    expect(killed).toEqual(["engage"]);
    await strictApp.close();
  });

  it("未配置 webhook 密钥时不校验（本地调试），但指令逻辑不变", async () => {
    const openApp = createGatewayServer({
      queue,
      channels: [],
      startLoop: false,
      killswitchPassphrase: PASSPHRASE,
      killswitchCommander: async (input) => {
        killed.push(input.command);
        return { ok: true, message: "ok" };
      },
    });
    const res = await openApp.inject({
      method: "POST",
      url: "/api/channels/telegram/webhook",
      payload: { message: { text: `${PASSPHRASE} 恢复`, chat: { id: 1 } } },
    });
    expect(res.statusCode).toBe(200);
    expect(killed).toEqual(["release"]);
    await openApp.close();
  });
});
