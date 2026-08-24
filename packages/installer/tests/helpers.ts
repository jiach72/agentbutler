import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Exec, ExecOptions, ExecResult, PlatformReport } from "../src/platform.js";
import type { ProbeFetch, ProbeMethod, SourcePlan } from "../src/network.js";
import { checkSecrets } from "../src/secrets.js";
import type { InstallPlan } from "../src/install.js";

/** 独立临时目录，避免污染真实环境。 */
export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "butler-installer-"));
}

export function rmTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export interface RecordedCall {
  command: string;
  args: string[];
  opts?: ExecOptions;
}

/** 可注入的假 exec：记录全部调用，行为由 impl 决定（默认全部成功）。 */
export function fakeExec(
  impl: (command: string, args: string[]) => ExecResult | Promise<ExecResult> = () => ({
    code: 0,
    stdout: "",
    stderr: "",
  }),
): { exec: Exec; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const exec: Exec = async (command, args, opts) => {
    calls.push({ command, args, opts });
    return impl(command, args);
  };
  return { exec, calls };
}

export interface ProbeCall {
  url: string;
  method: ProbeMethod;
  timeoutMs: number;
}

/** 可注入的假探测 fetch：reachable(url) 为 true 时返回 200，否则模拟网络错误。 */
export function fakeProbeFetch(
  reachable: (url: string) => boolean,
): ProbeFetch & { calls: ProbeCall[] } {
  const calls: ProbeCall[] = [];
  const fetcher: ProbeFetch & { calls: ProbeCall[] } = async (url, init) => {
    calls.push({ url, method: init.method, timeoutMs: init.timeoutMs });
    if (reachable(url)) {
      return { status: 200 };
    }
    throw new Error(`unreachable: ${url}`);
  };
  fetcher.calls = calls;
  return fetcher;
}

/** 构造平台报告（默认一切满足）。 */
export function fakePlatform(overrides: Partial<PlatformReport> = {}): PlatformReport {
  return {
    os: "linux",
    arch: "x64",
    isWsl: true,
    wslEvidence: ["/proc/version 含 microsoft"],
    nodeVersion: "22.11.0",
    nodeSatisfied: true,
    nodeRequirement: ">=22",
    dockerAvailable: true,
    dockerComposeAvailable: true,
    ...overrides,
  };
}

/** 构造单源探测结论（默认官方可达）。 */
export function fakeSourcePlan(overrides: Partial<SourcePlan> = {}): SourcePlan {
  return {
    id: "npm",
    label: "npm 包源",
    chosen: "official",
    chosenUrl: "https://registry.npmjs.org/",
    officialReachable: true,
    mirrorUsed: false,
    allFailed: false,
    blocking: true,
    ...overrides,
  };
}

/** 构造两通路共用的计划（默认全源官方可达、平台满足、密钥全缺）。 */
export function fakePlan(overrides: {
  platform?: Partial<PlatformReport>;
  dockerRegistry?: Partial<SourcePlan>;
  pypi?: Partial<SourcePlan>;
}): InstallPlan {
  return {
    platform: fakePlatform(overrides.platform),
    network: {
      results: [
        fakeSourcePlan({ id: "docker-registry", label: "Docker 镜像仓库", chosenUrl: "https://registry-1.docker.io/v2/", ...overrides.dockerRegistry }),
        fakeSourcePlan({ id: "pypi", label: "PyPI 包源", chosenUrl: "https://pypi.org/simple/", ...overrides.pypi }),
        fakeSourcePlan({ id: "npm" }),
        fakeSourcePlan({
          id: "model-endpoints",
          label: "模型端点",
          chosenUrl: "https://api.openai.com/v1/models",
          blocking: false,
        }),
      ],
    },
    secrets: checkSecrets({}),
  };
}
