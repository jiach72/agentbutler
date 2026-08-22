import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readHermesConfig } from "../src/config.js";
import { capabilityScan, parseRootPath } from "../src/capability-scan.js";
import { defaultProber, detect, type PortProber } from "../src/detect.js";
import { logSources } from "../src/log-sources.js";

/** fixture 专用假 key：仅用于验证“绝不回显”，不对应任何真实凭据。 */
const SECRET_KEY = "fixture-secret-key-never-echo";

let root: string;
let probeSucceeds: boolean;
let probeCalls: Array<{ host: string; port: number; timeoutMs: number }>;
let fakeProber: PortProber;

function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "hermes-fixture-"));
  mkdirSync(join(dir, "hermes-agent"), { recursive: true });
  mkdirSync(join(dir, "venv", "bin"), { recursive: true });
  mkdirSync(join(dir, "logs", "curator"), { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(
    join(dir, "config.yaml"),
    [
      "platforms:",
      "  api_server:",
      "    extra:",
      '      host: "127.0.0.1"',
      "      port: 18642",
      `      key: "${SECRET_KEY}"`,
      "  weixin:",
      "    extra:",
      "      min_send_interval_seconds: 30",
      "dashboard:",
      "  port: 9119",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "hermes-agent", "pyproject.toml"),
    '[project]\nname = "hermes-agent"\nversion = "0.20.4"\n',
  );
  writeFileSync(join(dir, "venv", "bin", "python"), "");
  writeFileSync(join(dir, "logs", "agent.log"), "agent line\n");
  writeFileSync(join(dir, "logs", "gateway.log"), "gateway line\n");
  writeFileSync(join(dir, "logs", "agent.log.1"), "rotated\n");
  writeFileSync(join(dir, "logs", "errors.log.2"), "rotated\n");
  writeFileSync(join(dir, "logs", "gateway.log.3"), "rotated\n");
  writeFileSync(join(dir, "logs", "curator", "repairs.log"), "nested\n");
  writeFileSync(join(dir, "memory_store.db"), "");
  return dir;
}

/** 目录快照：相对路径 + 内容 + mtime，用于验证 detect 纯读无副作用。 */
function snapshotDir(
  dir: string,
  prefix = "",
): Array<{ path: string; mtimeMs: number; content: string }> {
  const entries = readdirSync(dir, { withFileTypes: true })
    .map((e) => ({ e, name: prefix ? `${prefix}/${e.name}` : e.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const out: Array<{ path: string; mtimeMs: number; content: string }> = [];
  for (const { e, name } of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...snapshotDir(full, name));
    } else {
      out.push({
        path: name,
        mtimeMs: statSync(full).mtimeMs,
        content: readFileSync(full, "utf8"),
      });
    }
  }
  return out;
}

beforeEach(() => {
  root = writeFixture();
  probeSucceeds = true;
  probeCalls = [];
  fakeProber = async (host, port, timeoutMs) => {
    probeCalls.push({ host, port, timeoutMs });
    return probeSucceeds;
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env["HERMES_ROOT"];
});

describe("readHermesConfig", () => {
  it("解析 api_server / weixin 节流参数 / dashboard 段", async () => {
    const config = await readHermesConfig(root);
    expect(config).not.toBeNull();
    expect(config!.apiServer.host).toBe("127.0.0.1");
    expect(config!.apiServer.port).toBe(18642);
    expect(config!.apiServer.key).toBe(SECRET_KEY);
    expect(config!.weixinExtra?.["min_send_interval_seconds"]).toBe(30);
    expect(config!.hasDashboard).toBe(true);
  });

  it("config.yaml 缺失返回 null", async () => {
    rmSync(join(root, "config.yaml"));
    expect(await readHermesConfig(root)).toBeNull();
  });

  it("YAML 语法损坏返回 null 而非抛异常", async () => {
    writeFileSync(join(root, "config.yaml"), "platforms: [unclosed");
    expect(await readHermesConfig(root)).toBeNull();
  });
});

describe("detect", () => {
  it("完整 fixture：evidence 非空、confidence≥0.6、runtime=process、version 正确", async () => {
    const result = await detect({ rootPath: root }, { prober: fakeProber });
    expect(result.ok).toBe(true);
    const inst = result.data?.find((i) => i.rootPath === root);
    expect(inst).toBeDefined();
    expect(inst!.evidence.length).toBeGreaterThan(0);
    expect(inst!.confidence).toBeGreaterThanOrEqual(0.6);
    expect(inst!.confidence).toBe(0.95);
    expect(inst!.runtime).toBe("process");
    expect(inst!.version).toBe("0.20.4");
    expect(inst!.instanceId).toBe("hermes-main");
    expect(inst!.evidence).toContain(`目录存在: ${root}`);
    expect(inst!.evidence).toContain("config.yaml 存在");
    expect(inst!.evidence).toContain("pyproject.toml version=0.20.4");
    expect(inst!.evidence).toContain("API Server :18642 探活成功");
  });

  it("端口取自 config.yaml 的 api_server.extra.port", async () => {
    await detect({ rootPath: root }, { prober: fakeProber });
    expect(probeCalls).toEqual([{ host: "127.0.0.1", port: 18642, timeoutMs: 1500 }]);
  });

  it("探活失败：无 API 证据且置信度降低", async () => {
    probeSucceeds = false;
    const result = await detect({ rootPath: root }, { prober: fakeProber });
    const inst = result.data?.find((i) => i.rootPath === root);
    expect(inst).toBeDefined();
    expect(inst!.confidence).toBe(0.85);
    expect(inst!.runtime).toBe("process");
    expect(inst!.evidence.some((e) => e.includes("探活成功"))).toBe(false);
  });

  it("config.yaml 缺失：降置信，端口回退缺省 8642", async () => {
    rmSync(join(root, "config.yaml"));
    const result = await detect({ rootPath: root }, { prober: fakeProber });
    const inst = result.data?.find((i) => i.rootPath === root);
    expect(inst).toBeDefined();
    expect(inst!.confidence).toBe(0.9);
    expect(inst!.confidence).toBeLessThan(0.95);
    expect(inst!.version).toBe("0.20.4");
    expect(probeCalls[0]?.port).toBe(8642);
  });

  it("不存在的候选根：evidence 为空被丢弃，返回空列表", async () => {
    const result = await detect({ rootPath: join(root, "not-exist") }, { prober: fakeProber });
    expect(result.ok).toBe(true);
    expect(result.data).toHaveLength(0);
    expect(probeCalls).toHaveLength(0);
  });

  it("HERMES_ROOT 环境变量作为无 hint 时候选", async () => {
    process.env["HERMES_ROOT"] = root;
    const result = await detect(undefined, { prober: fakeProber });
    const inst = result.data?.find((i) => i.rootPath === root);
    expect(inst).toBeDefined();
    expect(inst!.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("detect 无副作用：目录内容与 mtime 快照前后一致", async () => {
    const before = snapshotDir(root);
    await detect({ rootPath: root }, { prober: fakeProber });
    expect(snapshotDir(root)).toEqual(before);
  });

  it("敏感 key 不出现在任何 Result 序列化输出中", async () => {
    const detectResult = await detect({ rootPath: root }, { prober: fakeProber });
    const scanResult = await capabilityScan(root, { prober: fakeProber });
    expect(JSON.stringify(detectResult)).not.toContain(SECRET_KEY);
    expect(JSON.stringify(scanResult)).not.toContain(SECRET_KEY);
    expect(JSON.stringify(logSources(root))).not.toContain(SECRET_KEY);
    expect(detectResult.data?.find((i) => i.rootPath === root)?.evidence.join("\n")).not.toContain(
      SECRET_KEY,
    );
  });

  it("默认探活器对未监听端口返回 false（不抛异常）", async () => {
    await expect(defaultProber("127.0.0.1", 1, 500)).resolves.toBe(false);
  });
});

describe("capabilityScan", () => {
  it("完整 fixture：未配置 Bridge 时 messaging unavailable 且 effectiveLevel=2", async () => {
    const r = await capabilityScan(root, { prober: fakeProber });
    expect(r.ok).toBe(true);
    expect(r.data!.effectiveLevel).toBe(2);
    expect(r.data!.capabilities).toEqual({
      probe: "ok",
      control: "ok",
      messaging: "unavailable",
      "skill-driver": "ok",
      "memory-driver": "ok",
      "config-driver": "ok",
    });
    expect(r.data!.anomalies).toEqual(["Hermes Bridge 未配置（消息接管未安装或未启用）"]);
    expect(typeof r.durationMs).toBe("number");
  });

  it("删掉 memory_store.db：仅 memory-driver 一项降级并记录 anomaly", async () => {
    rmSync(join(root, "memory_store.db"));
    const r = await capabilityScan(root, { prober: fakeProber });
    expect(r.ok).toBe(true);
    expect(r.data!.capabilities).toEqual({
      probe: "ok",
      control: "ok",
      messaging: "unavailable",
      "skill-driver": "ok",
      "memory-driver": "degraded",
      "config-driver": "ok",
    });
    expect(r.data!.anomalies).toEqual([
      "未找到 memory_store.db（记忆后端非默认）",
      "Hermes Bridge 未配置（消息接管未安装或未启用）",
    ]);
    expect(r.data!.effectiveLevel).toBe(2);
  });

  it("venv 缺失：仅 control 降级，probe ok 时 effectiveLevel=1", async () => {
    rmSync(join(root, "venv"), { recursive: true, force: true });
    const r = await capabilityScan(root, { prober: fakeProber });
    expect(r.data!.capabilities["control"]).toBe("degraded");
    expect(r.data!.capabilities["memory-driver"]).toBe("ok");
    expect(r.data!.capabilities["skill-driver"]).toBe("ok");
    expect(r.data!.capabilities["config-driver"]).toBe("ok");
    expect(r.data!.effectiveLevel).toBe(1);
  });

  it("探活失败且 venv 缺失：effectiveLevel=0", async () => {
    probeSucceeds = false;
    rmSync(join(root, "venv"), { recursive: true, force: true });
    const r = await capabilityScan(root, { prober: fakeProber });
    expect(r.data!.capabilities["probe"]).toBe("unavailable");
    expect(r.data!.capabilities["control"]).toBe("degraded");
    expect(r.data!.effectiveLevel).toBe(0);
  });

  it("control ok 时探活失败不影响 effectiveLevel=2", async () => {
    probeSucceeds = false;
    const r = await capabilityScan(root, { prober: fakeProber });
    expect(r.data!.capabilities["probe"]).toBe("unavailable");
    expect(r.data!.effectiveLevel).toBe(2);
  });

  it("支持 instanceId|rootPath 复合形式；裸 instanceId 无法解析出 rootPath", async () => {
    const r = await capabilityScan(`hermes-main|${root}`, { prober: fakeProber });
    expect(r.ok).toBe(true);
    expect(r.data!.capabilities["config-driver"]).toBe("ok");
    expect(parseRootPath("hermes-main")).toBeNull();
    expect(parseRootPath(`hermes-main|${root}`)).toBe(root);
  });
});

describe("logSources", () => {
  it("仅枚举 .log 文件，排除轮转（.1/.2/.3）与子目录", () => {
    const sources = logSources(root);
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.id)).toEqual(["hermes:logs:agent.log", "hermes:logs:gateway.log"]);
    for (const s of sources) {
      expect(s.format).toBe("text");
      expect(isAbsolute(s.path)).toBe(true);
    }
    expect(sources.some((s) => s.path.includes("agent.log.1"))).toBe(false);
    expect(sources.some((s) => s.path.includes("errors.log.2"))).toBe(false);
    expect(sources.some((s) => s.path.includes("gateway.log.3"))).toBe(false);
    expect(sources.some((s) => s.path.includes("curator"))).toBe(false);
  });

  it("logs 目录缺失返回空数组", () => {
    rmSync(join(root, "logs"), { recursive: true, force: true });
    expect(logSources(root)).toEqual([]);
  });
});
