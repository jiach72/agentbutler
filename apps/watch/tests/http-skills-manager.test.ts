/**
 * /api/skills-manager/* 端点测试：fake SkillsManagerCli 服务注入。
 * 覆盖：available 两种形态、dry-run（未 confirmed）参数、错误映射 409/503、未接线 503。
 */
import { afterEach, describe, expect, it } from "vitest";
import { SkillsManagerError, SKILLS_MANAGER_INSTALL_HINT, type SkillsManagerCli } from "../src/skills-manager.js";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";

interface RecordedCall {
  op: string;
  input: unknown;
}

function makeService(overrides: Partial<SkillsManagerCli> = {}): {
  service: SkillsManagerCli;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const service: SkillsManagerCli = {
    cliPath: "/usr/local/bin/skills-manager-cli",
    cliHome: "/tmp/cli-home",
    hermesSkillsDir: "/tmp/hermes/skills",
    run: async () => ({}),
    available: () => true,
    ensureTarget: () => ({ agent: "claude_code", dir: "/tmp/hermes/skills", symlinked: true }),
    status: async () => {
      calls.push({ op: "status", input: null });
      return {
        available: true,
        cli: { path: "/usr/local/bin/skills-manager-cli", version: "v1.36.0" },
        repo: { skill_count: 1 },
        skills: [{ skill_id: "s1", name: "demo" }],
        deployAgent: { key: "claude_code" },
        deployTarget: { agent: "claude_code", dir: "/tmp/hermes/skills", symlinked: true },
      };
    },
    install: async (input) => {
      calls.push({ op: "install", input });
      return { ok: true, dry_run: input.confirmed !== true };
    },
    deploy: async (input) => {
      calls.push({ op: "deploy", input });
      return { ok: true, dry_run: input.confirmed !== true };
    },
    undeploy: async (input) => {
      calls.push({ op: "undeploy", input });
      return { ok: true, dry_run: input.confirmed !== true };
    },
    check: async () => {
      calls.push({ op: "check", input: null });
      return [{ name: "demo", update_status: "up_to_date" }];
    },
    update: async (input) => {
      calls.push({ op: "update", input });
      return { ok: true, dry_run: input.confirmed !== true };
    },
    adopt: async (input) => {
      calls.push({ op: "adopt", input });
      return { ok: true, dry_run: input.confirmed !== true };
    },
    ...overrides,
  };
  return { service, calls };
}

function makeDeps(skillsManager?: SkillsManagerCli): WatchHttpDeps {
  return {
    scheduler: {
      runNow: () => true,
      status: () => ({ lastAt: null, nextAt: null, intervalMin: 60, inFlight: false }),
    },
    runbooks: () => [],
    executeRunbook: async () => ({ status: "no-servicing-instance" }),
    upgrade: {
      startUpgrade: () => ({ status: "missing-target-version" }),
      status: () => null,
      listVersions: async () => ({ reachable: false, versions: [] }),
      rollbackSnapshot: async () => ({ status: "snapshot-not-found" }),
    },
    gateway: {
      stats: async () => ({ overall: "ok", totalEvents: 0, last24h: 0, matched: [], suggestions: [] }),
      patches: async () => [],
      applyPatch: async () => ({ status: "unknown-patch" }),
      reapplyPatch: async () => ({ status: "unknown-patch" }),
      detectPatch: async () => ({ status: "unknown-patch" }),
    },
    skillsManager,
  };
}

describe("startWatchHttp /api/skills-manager 端点", () => {
  let http: WatchHttp;
  let base: string;

  async function boot(overrides: Partial<SkillsManagerCli> = {}): Promise<{ service: SkillsManagerCli; calls: RecordedCall[] }> {
    const fake = makeService(overrides);
    http = startWatchHttp(makeDeps(fake.service), { port: 0 });
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;
    return fake;
  }

  afterEach(() => http.close());

  it("GET status 返回服务视图；服务返回 unavailable 形态时仍 200", async () => {
    const fake = await boot();
    const res = await fetch(`${base}/api/skills-manager/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; repo: { skill_count: number } };
    expect(body.available).toBe(true);
    expect(body.repo.skill_count).toBe(1);
    expect(fake.calls[0]?.op).toBe("status");

    await boot({ status: async () => ({ available: false, installHint: SKILLS_MANAGER_INSTALL_HINT }) });
    const degraded = await fetch(`${base}/api/skills-manager/status`);
    expect(degraded.status).toBe(200);
    expect(await degraded.json()).toEqual({ available: false, installHint: SKILLS_MANAGER_INSTALL_HINT });
  });

  it("GET updates 转发 check()；POST install 未 confirmed 走 dry-run 预览", async () => {
    const fake = await boot();
    const updates = await fetch(`${base}/api/skills-manager/updates`);
    expect(updates.status).toBe(200);
    expect(await updates.json()).toEqual([{ name: "demo", update_status: "up_to_date" }]);

    const preview = await fetch(`${base}/api/skills-manager/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "owner/repo", name: "demo" }),
    });
    expect(preview.status).toBe(200);
    expect((await preview.json()) as { dry_run: boolean }).toMatchObject({ dry_run: true });
    expect(fake.calls.at(-1)).toEqual({
      op: "install",
      input: { source: "owner/repo", name: "demo", confirmed: false },
    });

    const applied = await fetch(`${base}/api/skills-manager/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "owner/repo", confirmed: true }),
    });
    expect(applied.status).toBe(200);
    expect(fake.calls.at(-1)).toEqual({
      op: "install",
      input: { source: "owner/repo", confirmed: true },
    });
  });

  it("deploy/undeploy/update/adopt 透传 confirmed 二段式", async () => {
    const fake = await boot();
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    await post("/api/skills-manager/deploy", { name: "demo" });
    expect(fake.calls.at(-1)).toEqual({ op: "deploy", input: { name: "demo", confirmed: false } });
    await post("/api/skills-manager/undeploy", { name: "demo", confirmed: true });
    expect(fake.calls.at(-1)).toEqual({ op: "undeploy", input: { name: "demo", confirmed: true } });
    await post("/api/skills-manager/update", { name: "demo", confirmed: true });
    expect(fake.calls.at(-1)).toEqual({ op: "update", input: { name: "demo", confirmed: true } });
    await post("/api/skills-manager/adopt", { dir: "/home/x/skills", confirmed: true });
    expect(fake.calls.at(-1)).toEqual({ op: "adopt", input: { dir: "/home/x/skills", confirmed: true } });
  });

  it("缺参数返回 400，非 GET/POST 返回 405", async () => {
    await boot();
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post("/api/skills-manager/install", { name: "x" })).status).toBe(400);
    expect((await post("/api/skills-manager/deploy", {})).status).toBe(400);
    expect((await post("/api/skills-manager/undeploy", { name: "" })).status).toBe(400);
    expect((await post("/api/skills-manager/update", {})).status).toBe(400);
    expect((await post("/api/skills-manager/adopt", {})).status).toBe(400);
    expect((await fetch(`${base}/api/skills-manager/status`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/skills-manager/updates`, { method: "POST" })).status).toBe(405);
  });

  it("错误映射：TARGET_CONFLICT → 409，INVALID_ARGUMENT → 400，unavailable → 503 + installHint", async () => {
    await boot({
      deploy: async () => {
        throw new SkillsManagerError("TARGET_CONFLICT", "already deployed elsewhere");
      },
      install: async () => {
        throw new SkillsManagerError("INVALID_ARGUMENT", "bad git url");
      },
      check: async () => {
        throw new SkillsManagerError("skills-manager-unavailable", "cli missing");
      },
      status: async () => {
        throw new SkillsManagerError("deploy-target-conflict", "真实目录占用");
      },
    });
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const conflict = await post("/api/skills-manager/deploy", { name: "demo", confirmed: true });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "TARGET_CONFLICT", message: "already deployed elsewhere" });

    const invalid = await post("/api/skills-manager/install", { source: "x", confirmed: true });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "INVALID_ARGUMENT" });

    const unavailable = await fetch(`${base}/api/skills-manager/updates`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      error: "skills-manager-unavailable",
      installHint: SKILLS_MANAGER_INSTALL_HINT,
    });

    const targetConflict = await fetch(`${base}/api/skills-manager/status`);
    expect(targetConflict.status).toBe(409);
    expect(await targetConflict.json()).toMatchObject({ code: "deploy-target-conflict" });
  });

  it("未接线服务 → 503 skills-manager-unavailable", async () => {
    http = startWatchHttp(makeDeps(undefined), { port: 0 });
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/api/skills-manager/status`)).status).toBe(503);
    expect((await fetch(`${base}/api/skills-manager/updates`)).status).toBe(503);
    const res = await fetch(`${base}/api/skills-manager/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo" }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "skills-manager-unavailable" });
  });
});
