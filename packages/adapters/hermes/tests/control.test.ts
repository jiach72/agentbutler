import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ERROR_TABLE, fail, type InstanceRef, type Result } from "@butler/contract";
import { SqliteStore } from "@butler/core";
import { createHermesAdapter } from "../src/index.js";
import type { UpgradeJobView } from "../src/control/index.js";
import {
  DockerExecutor,
  ProcessExecutor,
  dockerodeConnectOptions,
  type CommandExecutor,
  type CommandResult,
  type ContainerLike,
  type ExecutorOutcome,
} from "../src/control/executor.js";

/** 轮询等待条件成立（后台 Job 收敛终态）。 */
async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/* ------------------------------ 测试基础设施 ------------------------------ */

interface ExecCall {
  cmd: string;
  args: string[];
}

interface SpawnCall {
  cmd: string;
  args: string[];
}

/** 可编排的 fake 命令执行器：按 (cmd, args) 匹配 handler，未命中默认 code 0。 */
class FakeExec implements CommandExecutor {
  readonly calls: ExecCall[] = [];
  readonly spawns: SpawnCall[] = [];
  private spawnHook: (cmd: string, args: string[]) => void = () => {};
  private readonly handlers: Array<{
    match: (cmd: string, args: string[]) => boolean;
    run: (cmd: string, args: string[]) => CommandResult;
  }> = [];

  on(
    match: (cmd: string, args: string[]) => boolean,
    run: (cmd: string, args: string[]) => CommandResult,
  ): this {
    this.handlers.push({ match, run });
    return this;
  }

  onSystemctlCat(exists: boolean): this {
    return this.on(
      (cmd, args) => cmd === "systemctl" && args.includes("cat"),
      () => ({ code: exists ? 0 : 1, stdout: "", stderr: "" }),
    );
  }

  onSpawn(hook: (cmd: string, args: string[]) => void): this {
    this.spawnHook = hook;
    return this;
  }

  async exec(cmd: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ cmd, args });
    const handler = this.handlers.find((h) => h.match(cmd, args));
    return handler ? handler.run(cmd, args) : { code: 0, stdout: "", stderr: "" };
  }

  spawnDetached(cmd: string, args: string[]): void {
    this.spawns.push({ cmd, args });
    this.spawnHook(cmd, args);
  }

  callsOf(cmd: string): ExecCall[] {
    return this.calls.filter((c) => c.cmd === cmd);
  }
}

let base: string;
let root: string;
let store: SqliteStore;
let snapshotsDir: string;
let alive: boolean;
let fakeExec: FakeExec;

function writeMemoryValue(value: string): void {
  const db = new DatabaseSync(join(root, "memory_store.db"));
  try {
    db.prepare("INSERT OR REPLACE INTO fixture_memory (id, value) VALUES (1, ?)").run(value);
  } finally {
    db.close();
  }
}

function readMemoryValue(path = join(root, "memory_store.db")): string | undefined {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT value FROM fixture_memory WHERE id = 1").get() as { value?: string } | undefined)?.value;
  } finally {
    db.close();
  }
}

/** 控制面专用 fixture：伪 code/venv/data + config.yaml，独立临时基目录。 */
function writeControlFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "hermes-control-"));
  const rootPath = join(dir, "root");
  mkdirSync(join(rootPath, "hermes-agent"), { recursive: true });
  mkdirSync(join(rootPath, "venv", "bin"), { recursive: true });
  mkdirSync(join(rootPath, "skills", "fixture-skill"), { recursive: true });
  writeFileSync(join(rootPath, "hermes-agent", "main.py"), "# hermes-agent entry\n");
  writeFileSync(join(rootPath, "venv", "bin", "python"), "");
  writeFileSync(join(rootPath, "skills", "fixture-skill", "SKILL.md"), "# fixture skill\n");
  const memoryDb = new DatabaseSync(join(rootPath, "memory_store.db"));
  memoryDb.exec("CREATE TABLE fixture_memory (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  memoryDb.close();
  writeFileSync(
    join(rootPath, "config.yaml"),
    [
      "platforms:",
      "  api_server:",
      "    extra:",
      '      host: "127.0.0.1"',
      "      port: 18642",
      '      key: "fixture-key-never-echo"',
      "  weixin:",
      "    extra:",
      "      min_send_interval_seconds: 30",
      "",
    ].join("\n"),
  );
  return dir;
}

function makeProcessExecutor(unitName?: string): ProcessExecutor {
  return new ProcessExecutor({
    exec: fakeExec,
    prober: async () => alive,
    unitName,
  });
}

beforeEach(() => {
  base = writeControlFixture();
  root = join(base, "root");
  store = new SqliteStore(join(base, "butler-test.db"));
  snapshotsDir = join(base, "snapshots");
  mkdirSync(snapshotsDir, { recursive: true });
  alive = false;
  fakeExec = new FakeExec();
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
  delete process.env["DOCKER_HOST"];
});

/* ------------------------------ ProcessExecutor ------------------------------ */

describe("ProcessExecutor", () => {
  it("已在运行时 start 幂等成功：不执行任何命令", async () => {
    alive = true;
    const out = await makeProcessExecutor().start(root);
    expect(out.ok).toBe(true);
    expect(fakeExec.calls).toHaveLength(0);
  });

  it("start 优先 systemd user unit：unit 存在则 systemctl --user start", async () => {
    fakeExec.onSystemctlCat(true);
    fakeExec.on(
      (cmd, args) => cmd === "systemctl" && args.includes("start"),
      () => {
        alive = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    );
    const out = await makeProcessExecutor("hermes-gateway.service").start(root);
    expect(out.ok).toBe(true);
    const startCalls = fakeExec.callsOf("systemctl").filter((c) => c.args.includes("start"));
    expect(startCalls.map((c) => c.args.join(" "))).toContain("--user start hermes-gateway.service");
    expect(fakeExec.spawns).toHaveLength(0);
  });

  it("未显式配置 unit 时不探测或控制任意 systemd 服务", async () => {
    alive = false;
    fakeExec.onSystemctlCat(true);
    fakeExec.onSpawn(() => {
      alive = true;
    });
    const out = await makeProcessExecutor().start(root);
    expect(out.ok).toBe(true);
    expect(fakeExec.callsOf("systemctl")).toHaveLength(0);
    expect(fakeExec.spawns).toHaveLength(1);
  });

  it("unit 不存在时回退 spawn venv 入口", async () => {
    fakeExec.onSystemctlCat(false);
    fakeExec.onSpawn(() => {
      alive = true;
    });
    const out = await makeProcessExecutor().start(root);
    expect(out.ok).toBe(true);
    expect(fakeExec.spawns).toHaveLength(1);
    expect(fakeExec.spawns[0]!.cmd).toBe(join(root, "venv", "bin", "python"));
    expect(fakeExec.callsOf("systemctl").some((c) => c.args.includes("start"))).toBe(false);
  });

  it("无 unit 且无 venv 入口时 start 失败（E203）", async () => {
    rmSync(join(root, "venv"), { recursive: true, force: true });
    fakeExec.onSystemctlCat(false);
    const out = (await makeProcessExecutor().start(root)) as Extract<ExecutorOutcome, { ok: false }>;
    expect(out.ok).toBe(false);
    expect(out.code).toBe("E203");
  });

  it("start 等待就绪超时 → E202", async () => {
    fakeExec.onSystemctlCat(true);
    const out = (await makeProcessExecutor("hermes-gateway.service").start(root, { timeoutSec: 0 })) as Extract<
      ExecutorOutcome,
      { ok: false }
    >;
    expect(out.ok).toBe(false);
    expect(out.code).toBe("E202");
  });

  it("已停止时 stop 幂等成功：不发任何信号", async () => {
    alive = false;
    const out = await makeProcessExecutor("hermes-gateway.service").stop(root);
    expect(out.ok).toBe(true);
    expect(fakeExec.callsOf("kill")).toHaveLength(0);
    expect(fakeExec.callsOf("systemctl")).toHaveLength(0);
  });

  it("stop 走 systemd unit：stop 后退出即成功，无强杀", async () => {
    alive = true;
    fakeExec.onSystemctlCat(true);
    fakeExec.on(
      (cmd, args) => cmd === "systemctl" && args.includes("stop"),
      () => {
        alive = false;
        return { code: 0, stdout: "", stderr: "" };
      },
    );
    const out = await makeProcessExecutor("hermes-gateway.service").stop(root);
    expect(out.ok).toBe(true);
    const killCalls = fakeExec.calls.filter((c) => c.cmd === "systemctl" && c.args.includes("kill"));
    expect(killCalls).toHaveLength(0);
  });

  it("stop 非 unit 路径：SIGTERM 超时后 SIGKILL，仍存活 → E202", async () => {
    alive = true;
    fakeExec.onSystemctlCat(false);
    fakeExec.on(
      (cmd) => cmd === "pgrep",
      () => ({ code: 0, stdout: "4242\n", stderr: "" }),
    );
    const out = (await makeProcessExecutor().stop(root, { timeoutSec: 0 })) as Extract<
      ExecutorOutcome,
      { ok: false }
    >;
    expect(out.ok).toBe(false);
    expect(out.code).toBe("E202");
    const killArgs = fakeExec.callsOf("kill").map((c) => c.args.join(" "));
    expect(killArgs).toContain("4242");
    expect(killArgs).toContain("-9 4242");
  });

  it("stop SIGKILL 生效 → 成功", async () => {
    alive = true;
    let pidsRunning = true;
    fakeExec.onSystemctlCat(false);
    fakeExec.on(
      (cmd) => cmd === "pgrep",
      () => (pidsRunning ? { code: 0, stdout: "4242\n", stderr: "" } : { code: 1, stdout: "", stderr: "" }),
    );
    fakeExec.on(
      (cmd, args) => cmd === "kill" && args.includes("-9"),
      () => {
        alive = false;
        pidsRunning = false;
        return { code: 0, stdout: "", stderr: "" };
      },
    );
    const out = await makeProcessExecutor().stop(root, { timeoutSec: 0 });
    expect(out.ok).toBe(true);
  });

  it("restart = stop + start（unit 路径）", async () => {
    alive = true;
    fakeExec.onSystemctlCat(true);
    fakeExec.on(
      (cmd, args) => cmd === "systemctl" && args.includes("stop"),
      () => {
        alive = false;
        return { code: 0, stdout: "", stderr: "" };
      },
    );
    fakeExec.on(
      (cmd, args) => cmd === "systemctl" && args.includes("start"),
      () => {
        alive = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    );
    const out = await makeProcessExecutor("hermes-gateway.service").restart(root);
    expect(out.ok).toBe(true);
    const seq = fakeExec
      .callsOf("systemctl")
      .filter((c) => c.args.includes("start") || c.args.includes("stop"))
      .map((c) => (c.args.includes("stop") ? "stop" : "start"));
    expect(seq).toEqual(["stop", "start"]);
  });
});

/* ------------------------------ DockerExecutor ------------------------------ */

/** 带调用计数的 fake 容器：运行状态由外部闭包控制。 */
class FakeContainer implements ContainerLike {
  inspected = 0;
  started = 0;
  stopped = 0;
  restarted = 0;

  constructor(private readonly isRunning: () => boolean) {}

  async inspect(): Promise<{ State: { Running: boolean } }> {
    this.inspected += 1;
    return { State: { Running: this.isRunning() } };
  }

  async start(): Promise<unknown> {
    this.started += 1;
    return {};
  }

  async stop(): Promise<unknown> {
    this.stopped += 1;
    return {};
  }

  async restart(): Promise<unknown> {
    this.restarted += 1;
    return {};
  }
}

describe("DockerExecutor", () => {
  it("start 幂等：容器已在运行则不再调用 start", async () => {
    const container = new FakeContainer(() => true);
    const executor = new DockerExecutor({
      factory: () => ({ getContainer: () => container }),
      containerName: "hermes-prod",
    });
    const out = await executor.start();
    expect(out.ok).toBe(true);
    expect(container.started).toBe(0);
    expect(container.inspected).toBe(1);
  });

  it("stop 幂等：容器已停止则不再调用 stop", async () => {
    const container = new FakeContainer(() => false);
    const executor = new DockerExecutor({ factory: () => ({ getContainer: () => container }) });
    const out = await executor.stop();
    expect(out.ok).toBe(true);
    expect(container.stopped).toBe(0);
  });

  it("start/stop/restart 映射容器操作，容器名传给 getContainer", async () => {
    const container = new FakeContainer(() => false);
    let requestedName = "";
    const executor = new DockerExecutor({
      factory: () => ({
        getContainer: (name) => {
          requestedName = name;
          return container;
        },
      }),
      containerName: "hermes-prod",
    });
    expect((await executor.start()).ok).toBe(true);
    expect(container.started).toBe(1);
    expect(requestedName).toBe("hermes-prod");
    expect((await executor.restart()).ok).toBe(true);
    expect(container.restarted).toBe(1);
  });

  it("DOCKER_HOST env 传递给工厂；未设置时缺省 /var/run/docker.sock", async () => {
    const received: string[] = [];
    const container = new FakeContainer(() => false);
    const makeExecutor = () =>
      new DockerExecutor({
        factory: ({ dockerHost }) => {
          received.push(dockerHost);
          return { getContainer: () => container };
        },
      });
    process.env["DOCKER_HOST"] = "tcp://127.0.0.1:2375";
    expect((await makeExecutor().start()).ok).toBe(true);
    delete process.env["DOCKER_HOST"];
    expect((await makeExecutor().start()).ok).toBe(true);
    expect(received).toEqual(["tcp://127.0.0.1:2375", "/var/run/docker.sock"]);
  });

  it("dockerode 工厂抛错 → 控制操作 fail（E203）且降级只观察，不抛异常", async () => {
    const executor = new DockerExecutor({
      factory: () => {
        throw new Error("cannot connect to the Docker daemon");
      },
    });
    for (const out of [await executor.start(), await executor.stop(), await executor.restart()]) {
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.code).toBe("E203");
        expect(out.userHint).toBe("Docker 不可达，已降级为只观察");
      }
    }
    await expect(executor.isAlive()).resolves.toBe(false);
  });

  it("容器 inspect 拒绝同样降级只观察", async () => {
    const executor = new DockerExecutor({
      factory: () => ({
        getContainer: () => ({
          inspect: () => Promise.reject(new Error("daemon down")),
          start: () => Promise.resolve({}),
          stop: () => Promise.resolve({}),
          restart: () => Promise.resolve({}),
        }),
      }),
    });
    const out = await executor.start();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.userHint).toBe("Docker 不可达，已降级为只观察");
  });

  it("dockerodeConnectOptions 解析 unix/tcp 形态", () => {
    expect(dockerodeConnectOptions("unix:///run/user/1000/docker.sock")).toEqual({
      socketPath: "/run/user/1000/docker.sock",
    });
    expect(dockerodeConnectOptions("tcp://127.0.0.1:2375")).toEqual({ host: "127.0.0.1", port: 2375 });
    expect(dockerodeConnectOptions("/var/run/docker.sock")).toEqual({
      socketPath: "/var/run/docker.sock",
    });
  });
});

/* --------------------------- ControlAdapter 组装 --------------------------- */

describe("createHermesAdapter control 接线", () => {
  it("process 形态 start 返回 ControlAck，重复 start 幂等不报错", async () => {
    const adapter = createHermesAdapter({ exec: fakeExec, prober: async () => alive });
    const control = adapter.control;
    expect(control).toBeDefined();
    alive = true;
    const ref = { instanceId: "hermes-main", rootPath: root, runtime: "process" as const };
    const first = await control!.start(ref);
    const second = await control!.start(ref);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.data!.instanceId).toBe("hermes-main");
    expect(first.data!.action).toBe("start");
    expect(new Date(first.data!.startedAt).toString()).not.toBe("Invalid Date");
    expect(first.durationMs).toBeGreaterThanOrEqual(0);
    expect(fakeExec.calls).toHaveLength(0);
  });

  it("stop 经 systemd unit 执行（注入 exec 生效）", async () => {
    const adapter = createHermesAdapter({
      exec: fakeExec,
      prober: async () => alive,
      process: { unitName: "hermes-gateway.service" },
    });
    alive = true;
    fakeExec.onSystemctlCat(true);
    fakeExec.on(
      (cmd, args) => cmd === "systemctl" && args.includes("stop"),
      () => {
        alive = false;
        return { code: 0, stdout: "", stderr: "" };
      },
    );
    const out = await adapter.control!.stop({ instanceId: "hermes-main", rootPath: root }, { timeoutSec: 1 });
    expect(out.ok).toBe(true);
    expect(out.data!.action).toBe("stop");
    expect(fakeExec.callsOf("systemctl").some((c) => c.args.includes("stop"))).toBe(true);
  });

  it("docker 形态按 runtime 分派；daemon 不可达 → E203 降级只观察", async () => {
    const container = new FakeContainer(() => true);
    const adapter = createHermesAdapter({
      docker: { dockerodeFactory: () => ({ getContainer: () => container }) },
    });
    const okOut = await adapter.control!.start({
      instanceId: "hermes-main",
      rootPath: root,
      runtime: "docker",
    });
    expect(okOut.ok).toBe(true);
    expect(container.started).toBe(0);

    const broken = createHermesAdapter({
      docker: {
        dockerodeFactory: () => {
          throw new Error("daemon unreachable");
        },
      },
    });
    const failOut = await broken.control!.restart({
      instanceId: "hermes-main",
      rootPath: root,
      runtime: "docker",
    });
    expect(failOut.ok).toBe(false);
    expect(failOut.error!.code).toBe("E203");
    expect(failOut.error!.userHint).toBe("Docker 不可达，已降级为只观察");
  });

  it("process 形态缺 rootPath → E002", async () => {
    const adapter = createHermesAdapter({ exec: fakeExec, prober: async () => alive });
    const out = await adapter.control!.start({ instanceId: "hermes-main" });
    expect(out.ok).toBe(false);
    expect(out.error!.code).toBe("E002");
    expect(out.error!.userHint).toBeTruthy();
  });

  it("start/restart 在 block 级配置违例时强制拒绝", async () => {
    writeFileSync(
      join(root, "config.yaml"),
      "platforms:\n  weixin:\n    group_policy: open\n",
      "utf8",
    );
    const adapter = createHermesAdapter({ exec: fakeExec, prober: async () => false });
    const ref = { instanceId: "hermes-main", rootPath: root, runtime: "process" as const };

    const started = await adapter.control!.start(ref);
    const restarted = await adapter.control!.restart(ref);

    for (const result of [started, restarted]) {
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("E203");
      expect(result.error?.userHint).toContain("配置安全规则未通过");
    }
    expect(fakeExec.callsOf("systemctl")).toHaveLength(0);
  });

  it("upgrade 立即返回初始 Job（五步步骤固定）；缺 idempotencyKey → E002", async () => {
    const views: UpgradeJobView[] = [];
    const adapter = createHermesAdapter({
      store,
      snapshotsDir,
      exec: fakeExec,
      prober: async () => alive,
      upgrade: { emit: (v) => views.push(v) },
    });
    const out = await adapter.control!.upgrade(
      { instanceId: "hermes-main", rootPath: root },
      { version: "0.21.0" },
      { idempotencyKey: "upgrade-test" },
    );
    expect(out.ok).toBe(true);
    expect(out.data!.kind).toBe("upgrade");
    expect(out.data!.jobId).toBeTruthy();
    expect(out.data!.steps.map((s) => s.id)).toEqual(["precheck", "snapshot", "pull", "patches", "verify"]);
    expect(out.data!.steps.map((s) => s.label)).toEqual([
      "环境预检",
      "升级前快照",
      "拉取升级",
      "补丁重打与冲突检测",
      "健康验收",
    ]);

    // fixture 无 pyproject.toml → 后台收敛为 precheck 失败终态（emit 推送）。
    await waitUntil(() => views.some((v) => v.status === "failed"));
    const final = views[views.length - 1]!;
    expect(final.steps[0]!.status).toBe("failed");
    expect(final.steps[0]!.detail).toContain("pyproject");
    expect(final.error).toContain("环境预检未通过");
    // 预检失败无副作用：未执行快照/停止/回滚。
    expect(fakeExec.calls).toHaveLength(0);
    expect(store.listSnapshots("hermes-main")).toHaveLength(0);
    // 升级 Job 行已落库且收敛为 failed。
    const jobRow = store.findJobByIdempotencyKey("upgrade-test");
    expect(jobRow?.kind).toBe("upgrade");
    expect(jobRow?.status).toBe("failed");

    const bad = await adapter.control!.upgrade(
      { instanceId: "hermes-main", rootPath: root },
      { version: "0.21.0" },
      { idempotencyKey: "" },
    );
    expect(bad.ok).toBe(false);
    expect(bad.error!.code).toBe("E002");
    expect(bad.error!.userHint).toContain("幂等键");
  });

  it("升级流水线内部控制调用经注入能力路由 fail-closed", async () => {
    writeFileSync(
      join(root, "hermes-agent", "pyproject.toml"),
      "[project]\nversion = \"0.20.0\"\n",
      "utf8",
    );
    const calls: string[] = [];
    const routed = async <T>(
      method: string,
      _instance: InstanceRef,
      _capability: "control" | "config-driver",
      fn: () => Promise<Result<T>>,
    ): Promise<Result<T>> => {
      calls.push(method);
      return method === "snapshot" ? fail<T>("E103", "snapshot capability unavailable") : fn();
    };
    const adapter = createHermesAdapter({
      store,
      snapshotsDir,
      exec: fakeExec,
      prober: async () => alive,
      controlInvoker: routed,
    });
    const out = await adapter.control!.upgrade(
      { instanceId: "hermes-main", rootPath: root },
      { version: "0.21.0" },
      { idempotencyKey: "upgrade-routed-deny" },
    );
    expect(out.ok).toBe(true);
    await waitUntil(() => store.findJobByIdempotencyKey("upgrade-routed-deny")?.status === "failed");
    expect(calls).toEqual(["validateConfig", "snapshot"]);
    expect(store.findJobByIdempotencyKey("upgrade-routed-deny")?.steps.find((s) => s.id === "snapshot")?.detail).toContain("snapshot capability unavailable");
    expect(fakeExec.calls).toHaveLength(0);
  });

  it("所有失败错误码都来自契约错误码表", async () => {
    const adapter = createHermesAdapter({ exec: fakeExec, prober: async () => alive });
    const failures = [
      await adapter.control!.start({ instanceId: "hermes-main" }),
      await adapter.control!.upgrade(
        { instanceId: "hermes-main", rootPath: root },
        { version: "0.21.0" },
        { idempotencyKey: "" },
      ),
    ];
    for (const r of failures) {
      expect(r.ok).toBe(false);
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
      expect(Object.keys(ERROR_TABLE)).toContain(r.error!.code);
    }
  });
});

/* --------------------------------- snapshot --------------------------------- */

describe("snapshot", () => {
  function makeAdapter(unitName?: string) {
    return createHermesAdapter({
      store,
      snapshotsDir,
      exec: fakeExec,
      prober: async () => alive,
      process: unitName ? { unitName } : undefined,
    });
  }

  const ref = () => ({ instanceId: "hermes-main", rootPath: root });

  it("按 scope 复制目录/文件并登记：steps = 各 include 项 + 收尾登记", async () => {
    const r = await makeAdapter().control!.snapshot(ref(), { include: ["code", "venv", "data"] });
    expect(r.ok).toBe(true);
    const job = r.data!;
    expect(job.kind).toBe("snapshot");
    expect(job.jobId).toBeTruthy();
    expect(job.steps.map((s) => s.id)).toEqual(["copy-code", "copy-venv", "copy-data", "register"]);
    expect(job.steps.every((s) => s.status === "passed")).toBe(true);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);

    const rows = store.listSnapshots("hermes-main");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("ok");
    const scope = rows[0]!.scope as { include: string[]; snapshotId: string };
    expect(scope.include).toEqual(["code", "venv", "data"]);
    const snapRoot = join(snapshotsDir, "hermes-main", scope.snapshotId);
    expect(existsSync(join(snapRoot, "code", "main.py"))).toBe(true);
    expect(existsSync(join(snapRoot, "venv", "bin", "python"))).toBe(true);
    expect(existsSync(join(snapRoot, "data", "memory_store.db"))).toBe(true);
  });

  it("进化前快照支持 skills + memory 两个语义范围", async () => {
    writeMemoryValue("memory-v1");
    const r = await makeAdapter().control!.snapshot(ref(), {
      include: ["skills", "memory"],
      label: "pre-evolution",
    });

    expect(r.ok).toBe(true);
    expect(r.data!.steps.map((step) => [step.id, step.status])).toEqual([
      ["copy-skills", "passed"],
      ["copy-memory", "passed"],
      ["register", "passed"],
    ]);

    const scope = store.listSnapshots("hermes-main")[0]!.scope as {
      include: string[];
      snapshotId: string;
    };
    const snapRoot = join(snapshotsDir, "hermes-main", scope.snapshotId);
    expect(readFileSync(join(snapRoot, "skills", "fixture-skill", "SKILL.md"), "utf8")).toBe(
      "# fixture skill\n",
    );
    expect(readMemoryValue(join(snapRoot, "memory", "memory_store.db"))).toBe("memory-v1");
  });

  it("运行中 WAL 数据被收敛为可独立读取且完整的主库快照", async () => {
    const source = new DatabaseSync(join(root, "memory_store.db"));
    try {
      source.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      source.prepare("INSERT OR REPLACE INTO fixture_memory (id, value) VALUES (1, ?)").run("wal-only-value");
      expect(existsSync(join(root, "memory_store.db-wal"))).toBe(true);

      const r = await makeAdapter().control!.snapshot(ref(), { include: ["data"], label: "live-wal" });
      expect(r.ok).toBe(true);
      expect(r.data!.steps.map((step) => [step.id, step.status])).toEqual([
        ["copy-data", "passed"],
        ["register", "passed"],
      ]);

      const scope = store.listSnapshots("hermes-main")[0]!.scope as { snapshotId: string };
      const snapshotDbPath = join(snapshotsDir, "hermes-main", scope.snapshotId, "data", "memory_store.db");
      expect(readMemoryValue(snapshotDbPath)).toBe("wal-only-value");
      expect(existsSync(`${snapshotDbPath}-wal`)).toBe(false);
      expect(existsSync(`${snapshotDbPath}-shm`)).toBe(false);
      const snapshotDb = new DatabaseSync(snapshotDbPath, { readOnly: true });
      try {
        expect(snapshotDb.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        snapshotDb.close();
      }
    } finally {
      source.close();
    }
  });

  it("SQLite 快照失败时不登记且清理部分目录", async () => {
    writeFileSync(join(root, "memory_store.db"), "not-a-sqlite-database");
    const r = await makeAdapter().control!.snapshot(ref(), { include: ["data"] });

    expect(r.ok).toBe(true);
    expect(r.data!.steps.map((step) => [step.id, step.status])).toEqual([
      ["copy-data", "failed"],
      ["register", "skipped"],
    ]);
    expect(store.listSnapshots("hermes-main")).toHaveLength(0);
    expect(readdirSync(join(snapshotsDir, "hermes-main"))).toHaveLength(0);
  });

  it("scope.label 透传到快照登记", async () => {
    const r = await makeAdapter().control!.snapshot(ref(), { include: ["data"], label: "pre-upgrade" });
    expect(r.ok).toBe(true);
    const rows = store.listSnapshots("hermes-main");
    expect(rows[0]!.label).toBe("pre-upgrade");
  });

  it("未知名与缺失目标 → 对应 step skipped 且带 detail", async () => {
    rmSync(join(root, "venv"), { recursive: true, force: true });
    const r = await makeAdapter().control!.snapshot(ref(), { include: ["code", "nope", "venv"] });
    expect(r.ok).toBe(true);
    const steps = r.data!.steps;
    const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
    expect(byId["copy-nope"]!.status).toBe("skipped");
    expect(byId["copy-nope"]!.detail).toContain("未知");
    expect(byId["copy-venv"]!.status).toBe("skipped");
    expect(byId["copy-venv"]!.detail).toBeTruthy();
    expect(byId["copy-code"]!.status).toBe("passed");
    expect(byId["register"]!.status).toBe("passed");
  });

  it("保留 3 份：第 4 次快照后最旧目录被删 + 登记 status=expired", async () => {
    const adapter = makeAdapter();
    for (let i = 0; i < 4; i += 1) {
      writeMemoryValue(`content-${i}`);
      const r = await adapter.control!.snapshot(ref(), { include: ["data"] });
      expect(r.ok).toBe(true);
    }
    const rows = store.listSnapshots("hermes-main"); // id 降序（新→旧）
    expect(rows).toHaveLength(4);
    expect(rows[0]!.status).toBe("ok");
    expect(rows[1]!.status).toBe("ok");
    expect(rows[2]!.status).toBe("ok");
    expect(rows[3]!.status).toBe("expired");
    const instanceDir = join(snapshotsDir, "hermes-main");
    const dirs = readdirSync(instanceDir).filter((n) => !n.includes("pre-rollback"));
    expect(dirs).toHaveLength(3);
    const oldestSnapshotId = (rows[3]!.scope as { snapshotId: string }).snapshotId;
    expect(dirs).not.toContain(oldestSnapshotId);
    const newestSnapshotId = (rows[0]!.scope as { snapshotId: string }).snapshotId;
    expect(dirs).toContain(newestSnapshotId);
  });
});

/* --------------------------------- rollback --------------------------------- */

describe("rollback", () => {
  function makeAdapter(unitName?: string) {
    return createHermesAdapter({
      store,
      snapshotsDir,
      exec: fakeExec,
      prober: async () => alive,
      process: unitName ? { unitName } : undefined,
    });
  }

  const ref = () => ({ instanceId: "hermes-main", rootPath: root });

  async function snapshotNow(adapter: ReturnType<typeof makeAdapter>, dataContent: string): Promise<string> {
    writeMemoryValue(dataContent);
    const r = await adapter.control!.snapshot(ref(), { include: ["data", "code"] });
    expect(r.ok).toBe(true);
    return (store.listSnapshots("hermes-main")[0]!.scope as { snapshotId: string }).snapshotId;
  }

  it("回滚恢复被修改的内容，当前态备份到 .pre-rollback", async () => {
    const adapter = makeAdapter();
    const snapshotId = await snapshotNow(adapter, "v1");
    writeMemoryValue("v2");
    writeFileSync(join(root, "hermes-agent", "main.py"), "# tampered\n");

    const r = await adapter.control!.rollback(ref(), { snapshotId });
    expect(r.ok).toBe(true);
    const job = r.data!;
    expect(job.kind).toBe("rollback");
    expect(job.jobId).toBeTruthy();
    expect(job.steps.every((s) => s.status === "passed" || s.status === "skipped")).toBe(true);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);

    expect(readMemoryValue()).toBe("v1");
    expect(readFileSync(join(root, "hermes-agent", "main.py"), "utf8")).toBe("# hermes-agent entry\n");

    const preDir = join(snapshotsDir, "hermes-main", `${snapshotId}.pre-rollback`);
    expect(readMemoryValue(join(preDir, "data", "memory_store.db"))).toBe("v2");
    expect(readFileSync(join(preDir, "code", "main.py"), "utf8")).toBe("# tampered\n");
  });

  it("运行中实例回滚：fake 执行器收到 stop → start 序列", async () => {
    const adapter = makeAdapter("hermes-gateway.service");
    alive = true;
    fakeExec.onSystemctlCat(true);
    fakeExec.on(
      (cmd, args) => cmd === "systemctl" && args.includes("stop"),
      () => {
        alive = false;
        return { code: 0, stdout: "", stderr: "" };
      },
    );
    fakeExec.on(
      (cmd, args) => cmd === "systemctl" && args.includes("start"),
      () => {
        alive = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    );
    const snapshotId = await snapshotNow(adapter, "v1");
    writeMemoryValue("v2");

    const r = await adapter.control!.rollback(ref(), { snapshotId });
    expect(r.ok).toBe(true);
    expect(readMemoryValue()).toBe("v1");
    const seq = fakeExec
      .callsOf("systemctl")
      .filter((c) => c.args.includes("stop") || c.args.includes("start"))
      .map((c) => (c.args.includes("stop") ? "stop" : "start"));
    expect(seq[0]).toBe("stop");
    expect(seq[seq.length - 1]).toBe("start");
  });

  it("已停止实例回滚：不触发 stop/start", async () => {
    const adapter = makeAdapter();
    const snapshotId = await snapshotNow(adapter, "v1");
    writeMemoryValue("v2");
    const r = await adapter.control!.rollback(ref(), { snapshotId });
    expect(r.ok).toBe(true);
    expect(fakeExec.callsOf("systemctl")).toHaveLength(0);
    expect(readMemoryValue()).toBe("v1");
  });

  it("快照缺失 → fail（E204）", async () => {
    const r = await makeAdapter().control!.rollback(ref(), { snapshotId: "no-such-snapshot" });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("E204");
    expect(r.error!.userHint).toBeTruthy();
  });
});

/* ------------------------------- validateConfig ------------------------------- */

describe("validateConfig", () => {
  function makeAdapter() {
    return createHermesAdapter({ exec: fakeExec, prober: async () => alive });
  }

  const ref = () => ({ instanceId: "hermes-main", rootPath: root });

  function writeConfig(lines: string[]): void {
    writeFileSync(join(root, "config.yaml"), `${lines.join("\n")}\n`);
  }

  function writeEnv(map: Record<string, string>): void {
    writeFileSync(
      join(root, ".env"),
      `${Object.entries(map)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")}\n`,
    );
  }

  async function run() {
    const r = await makeAdapter().control!.validateConfig(ref());
    expect(r.ok).toBe(true);
    return r.data!;
  }

  it("默认 fixture：仅 throttle warn（30<45），passed=true", async () => {
    const v = await run();
    expect(v.passed).toBe(true);
    expect(v.violations).toEqual([
      { invariant: "INV-throttle-floor", severity: "warn", detail: expect.stringContaining("30") },
    ]);
  });

  it("INV-weixin-open-policy：.env policy=open 且无任何白名单 → block 且 passed=false", async () => {
    writeEnv({ WEIXIN_GROUP_POLICY: "open" });
    const v = await run();
    expect(v.passed).toBe(false);
    const inv = v.violations.find((x) => x.invariant === "INV-weixin-open-policy");
    expect(inv?.severity).toBe("block");
  });

  it("INV-weixin-open-policy：open + .env 白名单 → 不误报", async () => {
    writeEnv({ WEIXIN_GROUP_POLICY: "open", WEIXIN_GROUP_WHITELIST: "g1,g2" });
    const v = await run();
    expect(v.violations.some((x) => x.invariant === "INV-weixin-open-policy")).toBe(false);
  });

  it("INV-weixin-open-policy：open + config.yaml weixin 白名单字段 → 不误报", async () => {
    writeEnv({ WEIXIN_GROUP_POLICY: "open" });
    writeConfig([
      "platforms:",
      "  weixin:",
      "    group_policy: open",
      "    group_whitelist:",
      "      - g1",
      "    extra:",
      "      min_send_interval_seconds: 45",
    ]);
    const v = await run();
    expect(v.violations.some((x) => x.invariant === "INV-weixin-open-policy")).toBe(false);
  });

  it("INV-api-key-pairing：非回环 host 且无 key → block", async () => {
    writeConfig([
      "platforms:",
      "  api_server:",
      "    extra:",
      '      host: "0.0.0.0"',
      "      port: 18642",
      "  weixin:",
      "    extra:",
      "      min_send_interval_seconds: 45",
    ]);
    const v = await run();
    expect(v.passed).toBe(false);
    const inv = v.violations.find((x) => x.invariant === "INV-api-key-pairing");
    expect(inv?.severity).toBe("block");
    expect(inv?.detail).not.toContain("fixture-key-never-echo");
  });

  it("INV-api-key-pairing：非回环 host + key 配对 → 不误报；127.0.0.1 无 key 也不误报", async () => {
    writeConfig([
      "platforms:",
      "  api_server:",
      "    extra:",
      '      host: "10.0.0.5"',
      "      port: 18642",
      '      key: "paired-key"',
      "  weixin:",
      "    extra:",
      "      min_send_interval_seconds: 45",
    ]);
    let v = await run();
    expect(v.violations.some((x) => x.invariant === "INV-api-key-pairing")).toBe(false);

    writeConfig([
      "platforms:",
      "  api_server:",
      "    extra:",
      '      host: "127.0.0.1"',
      "      port: 18642",
      "  weixin:",
      "    extra:",
      "      min_send_interval_seconds: 45",
    ]);
    v = await run();
    expect(v.violations.some((x) => x.invariant === "INV-api-key-pairing")).toBe(false);
  });

  it("字段缺失不误报：config.yaml 与 .env 均缺失 → 无违例", async () => {
    rmSync(join(root, "config.yaml"));
    const v = await run();
    expect(v.violations).toEqual([]);
    expect(v.passed).toBe(true);
  });

  it("INV-throttle-floor：45 不违例；字段缺失不违例", async () => {
    writeConfig([
      "platforms:",
      "  weixin:",
      "    extra:",
      "      min_send_interval_seconds: 45",
    ]);
    let v = await run();
    expect(v.violations.some((x) => x.invariant === "INV-throttle-floor")).toBe(false);

    writeConfig(["platforms:", "  weixin:", "    extra: {}"]);
    v = await run();
    expect(v.violations.some((x) => x.invariant === "INV-throttle-floor")).toBe(false);
  });

  it("缺 rootPath → fail（E002）", async () => {
    const r = await makeAdapter().control!.validateConfig({ instanceId: "hermes-main" });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("E002");
  });
});

/* fixture 健全性 */
describe("control fixture sanity", () => {
  it("fixture 关键路径存在", () => {
    expect(existsSync(join(root, "hermes-agent", "main.py"))).toBe(true);
    expect(existsSync(join(root, "venv", "bin", "python"))).toBe(true);
    expect(existsSync(join(root, "memory_store.db"))).toBe(true);
    expect(readFileSync(join(root, "config.yaml"), "utf8")).toContain("min_send_interval_seconds: 30");
  });
});
