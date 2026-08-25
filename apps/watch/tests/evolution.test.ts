import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandExecutor, CommandResult } from "@butler/adapter-hermes";
import {
  ok,
  type ControlAdapter,
  type InstanceRef,
  type Job,
  type Result,
  type SnapshotScope,
} from "@butler/contract";
import { createCore, type Core } from "@butler/core";
import { createEvolutionService, type EvolutionService } from "../src/evolution.js";
import type { AlertPoster } from "../src/alert-forward.js";
import type { FetchLike } from "../src/dashboard-signal.js";

let tmp: string;
let root: string;
let core: Core;
let service: EvolutionService;
let dependencyMissing: string[];
let endpointStatus: number;
let snapshotCalls: Array<{ instance: InstanceRef; scope: SnapshotScope }>;
let alerts: Array<Record<string, unknown>>;

const exec: CommandExecutor = {
  exec: async (_cmd, args): Promise<CommandResult> => {
    const deps = args.slice(2);
    const found = Object.fromEntries(deps.map((dep) => [dep, !dependencyMissing.includes(dep)]));
    return { code: 0, stdout: `${JSON.stringify(found)}\n`, stderr: "" };
  },
  spawnDetached: () => {},
};

const fetchFn: FetchLike = async () => ({
  ok: endpointStatus >= 200 && endpointStatus < 300,
  status: endpointStatus,
  json: async () => ({}),
});

const control: Pick<ControlAdapter, "snapshot"> = {
  snapshot: async (instance, scope): Promise<Result<Job>> => {
    snapshotCalls.push({ instance, scope });
    core.store.insertSnapshot({
      instance: instance.instanceId,
      scope: { include: scope.include, snapshotId: "snap-evo-1" },
      label: scope.label,
    });
    return ok(
      {
        jobId: "snapshot-job-1",
        kind: "snapshot",
        steps: [
          { id: "copy-skills", label: "复制 skills", status: "passed" },
          { id: "copy-memory", label: "复制 memory", status: "passed" },
          { id: "register", label: "登记快照", status: "passed" },
        ],
      },
      Date.now(),
    );
  },
};

const poster: AlertPoster = {
  post: async (body) => {
    alerts.push(body as unknown as Record<string, unknown>);
  },
  flush: async () => {},
};

function seedInstance(): void {
  const created = core.instances.createInstance({
    instanceId: "hermes-main",
    frameworkId: "hermes",
    runtime: "process",
    rootPath: root,
    confidence: 0.9,
  });
  expect(created.ok).toBe(true);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "butler-evolution-"));
  root = join(tmp, "hermes");
  mkdirSync(join(root, "venv", "bin"), { recursive: true });
  mkdirSync(join(root, "skills"), { recursive: true });
  writeFileSync(join(root, "venv", "bin", "python"), "");
  core = createCore({ home: join(tmp, "butler-home") });
  dependencyMissing = [];
  endpointStatus = 401;
  snapshotCalls = [];
  alerts = [];
  seedInstance();
  service = createEvolutionService({
    core,
    control,
    exec,
    fetchFn,
    poster,
    now: () => Date.parse("2026-08-21T03:00:00.000Z"),
  });
});

afterEach(() => {
  core.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("进化预检与 holdout 硬门槛", () => {
  it("holdout=2：拒绝运行、不给快照、附可执行扩集动作并落 Markdown", async () => {
    const outcome = await service.preflight({
      instanceId: "hermes-main",
      dependencies: ["dspy", "gepa", "optuna"],
      endpoint: "https://api.example.test/v1",
      holdoutCount: 2,
      datasetPath: join(root, "datasets", "holdout.jsonl"),
      config: { engine: "gepa", iterations: 3 },
    });

    expect(outcome.status).toBe("rejected-preflight");
    expect(outcome.allowRun).toBe(false);
    expect(outcome.checks.find((check) => check.id === "dataset")).toMatchObject({
      status: "fail",
      action: expect.stringContaining("扩集"),
    });
    expect(outcome.nextAction).toMatchObject({ kind: "expand-dataset", targetCount: 10 });
    expect(snapshotCalls).toHaveLength(0);
    expect(existsSync(outcome.ledgerPath)).toBe(true);
    expect(readFileSync(outcome.ledgerPath, "utf8")).toContain("holdout 仅 2 条");
  });

  it("三项预检通过后才创建 skills + memory 运行前快照", async () => {
    const outcome = await service.preflight({
      instanceId: "hermes-main",
      dependencies: ["dspy", "gepa"],
      endpoint: "https://api.example.test/v1",
      holdoutCount: 12,
    });

    expect(outcome.status).toBe("ready");
    expect(outcome.allowRun).toBe(true);
    expect(outcome.snapshotId).toBe("snap-evo-1");
    expect(snapshotCalls).toEqual([
      {
        instance: expect.objectContaining({ instanceId: "hermes-main", rootPath: root }),
        scope: { include: ["skills", "memory"], label: "pre-evolution" },
      },
    ]);
    expect(outcome.checks.map((check) => [check.id, check.status])).toEqual([
      ["dependencies", "pass"],
      ["endpoint", "pass"],
      ["dataset", "pass"],
      ["snapshot", "pass"],
    ]);
  });

  it("不会把历史同标签快照误当成本次运行快照", async () => {
    core.store.insertSnapshot({
      instance: "hermes-main",
      scope: { include: ["skills", "memory"], snapshotId: "old-pre-evolution" },
      label: "pre-evolution",
    });
    const noRegistrationControl: Pick<ControlAdapter, "snapshot"> = {
      snapshot: async () =>
        ok(
          {
            jobId: "snapshot-without-registration",
            kind: "snapshot",
            steps: [
              { id: "copy-skills", label: "复制 skills", status: "passed" },
              { id: "copy-memory", label: "复制 memory", status: "passed" },
            ],
          },
          Date.now(),
        ),
    };
    const isolated = createEvolutionService({
      core,
      control: noRegistrationControl,
      exec,
      fetchFn,
      poster,
      now: () => Date.parse("2026-08-21T03:00:00.000Z"),
    });

    const outcome = await isolated.preflight({
      instanceId: "hermes-main",
      dependencies: ["dspy", "gepa"],
      endpoint: "https://api.example.test/v1",
      holdoutCount: 12,
    });

    expect(outcome.status).toBe("rejected-preflight");
    expect(outcome.allowRun).toBe(false);
    expect(outcome.snapshotId).toBeUndefined();
    expect(outcome.checks.find((check) => check.id === "snapshot")).toMatchObject({
      status: "fail",
      detail: "快照结果缺少登记信息",
    });
  });

  it("依赖缺失或端点 5xx：拒绝并给出明确修复动作", async () => {
    dependencyMissing = ["optuna"];
    endpointStatus = 503;
    const outcome = await service.preflight({
      instanceId: "hermes-main",
      dependencies: ["dspy", "optuna"],
      endpoint: "https://api.example.test/v1",
      holdoutCount: 10,
    });

    expect(outcome.status).toBe("rejected-preflight");
    expect(outcome.checks.find((check) => check.id === "dependencies")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("optuna"),
      action: expect.stringContaining("venv"),
    });
    expect(outcome.checks.find((check) => check.id === "endpoint")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("503"),
      action: expect.stringContaining("端点"),
    });
  });
});

describe("最小扩集与自动重检", () => {
  it("复用种子样本补齐到 10，写 JSONL 后自动重检并进入 ready", async () => {
    const rejected = await service.preflight({
      instanceId: "hermes-main",
      dependencies: ["dspy", "gepa"],
      endpoint: "https://api.example.test/v1",
      holdoutCount: 2,
    });

    const expanded = await service.expandDataset({
      runId: rejected.runId,
      holdoutCount: 2,
      targetCount: 10,
      seedExamples: [
        { input: "alpha", expected: "A" },
        { input: "beta", expected: "B" },
      ],
    });

    expect(expanded.status).toBe("ready");
    expect(expanded.beforeCount).toBe(2);
    expect(expanded.afterCount).toBe(10);
    expect(expanded.syntheticCount).toBe(8);
    expect(expanded.recheck.allowRun).toBe(true);
    expect(existsSync(expanded.datasetPath)).toBe(true);
    const rows = readFileSync(expanded.datasetPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(10);
    expect(rows[2]._butlerSynthetic).toMatchObject({ synthetic: true, sourceIndex: 0 });
    expect(snapshotCalls).toHaveLength(1);
  });
});

describe("运行后守门与台账导出", () => {
  async function readyRun(): Promise<string> {
    const preflight = await service.preflight({
      instanceId: "hermes-main",
      dependencies: ["dspy", "gepa"],
      endpoint: "https://api.example.test/v1",
      holdoutCount: 12,
      config: { engine: "gepa", rollout: 8 },
    });
    expect(preflight.status).toBe("ready");
    return preflight.runId;
  }

  it("指标回落：拒绝落盘、baseline 保留、紧急告警、台账记录", async () => {
    const runId = await readyRun();
    const decision = await service.recordResult({
      runId,
      baselineMetric: 0.541,
      candidateMetric: 0.425,
      significant: false,
      errors: ["metric regression"],
      rootCause: "holdout 分布偏差",
      fixes: ["回看数据集类别分布"],
    });

    expect(decision.status).toBe("rejected-regression");
    expect(decision.allowWrite).toBe(false);
    expect(decision.baselinePreserved).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: "evolution-regression",
      severity: "critical",
      dedupeKey: `evolution-regression:${runId}`,
    });
    const exported = service.exportLedger(runId);
    expect(exported?.filename).toBe(`evolution-${runId}.md`);
    expect(exported?.markdown).toContain("0.541 → 0.425");
    expect(exported?.markdown).toContain("负优化");
    expect(exported?.markdown).toContain("baseline 保留");
  });

  it("零增益即使误标显著也保持 baseline；显著正增益只返回准入许可、不代引擎写文件", async () => {
    const unchangedId = await readyRun();
    const unchanged = await service.recordResult({
      runId: unchangedId,
      baselineMetric: 0.534,
      candidateMetric: 0.534,
      significant: true,
    });
    expect(unchanged).toMatchObject({
      status: "kept-baseline",
      allowWrite: false,
      baselinePreserved: true,
    });

    const improvedId = await readyRun();
    const improved = await service.recordResult({
      runId: improvedId,
      baselineMetric: 0.5,
      candidateMetric: 0.56,
      significant: true,
    });
    expect(improved).toMatchObject({
      status: "accepted",
      allowWrite: false,
      baselinePreserved: true,
    });
    expect(readdirSync(join(root, "skills"))).toHaveLength(0);
  });

  it("显著正增益签发一次性令牌，并只允许在 skills 根目录内原子替换", async () => {
    const targetPath = join(root, "skills", "baseline.md");
    const candidatePath = join(root, "skills", "candidate.md");
    writeFileSync(targetPath, "baseline-v1\n");
    writeFileSync(candidatePath, "candidate-v2\n");
    const runId = await readyRun();
    const decision = await service.recordResult({
      runId,
      baselineMetric: 0.5,
      candidateMetric: 0.62,
      significant: true,
      targetPath,
      candidatePath,
    });
    expect(decision.status).toBe("accepted");
    expect(decision.writeAuthority).toMatchObject({ runId, targetPath, candidatePath });
    const token = decision.writeAuthority!.token;

    const promoted = service.promoteArtifact({ runId, token });
    expect(promoted).toMatchObject({ status: "promoted", runId, targetPath, candidatePath });
    expect(readFileSync(targetPath, "utf8")).toBe("candidate-v2\n");
    expect(service.promoteArtifact({ runId, token })).toMatchObject({
      status: "error",
      error: "authority-used",
    });
  });

  it("目标文件变化或候选篡改时拒绝采用，不覆盖 baseline", async () => {
    const targetPath = join(root, "skills", "baseline.md");
    const candidatePath = join(root, "skills", "candidate.md");
    writeFileSync(targetPath, "baseline-v1\n");
    writeFileSync(candidatePath, "candidate-v2\n");
    const runId = await readyRun();
    const decision = await service.recordResult({
      runId,
      baselineMetric: 0.5,
      candidateMetric: 0.62,
      significant: true,
      targetPath,
      candidatePath,
    });
    writeFileSync(targetPath, "baseline-drifted\n");
    const rejected = service.promoteArtifact({ runId, token: decision.writeAuthority!.token });
    expect(rejected).toMatchObject({ status: "error", error: "target-changed" });
    expect(readFileSync(targetPath, "utf8")).toBe("baseline-drifted\n");
  });
});
