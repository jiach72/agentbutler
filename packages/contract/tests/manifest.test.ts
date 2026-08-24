import { describe, expect, it } from "vitest";
import { parseManifest } from "../src/manifest";

function validManifest() {
  return {
    frameworkId: "hermes",
    displayName: "Hermes 管家适配器",
    contractVersion: "1.x",
    adapterVersion: "0.1.0",
    declaredLevel: 3,
    capabilities: ["probe", "control", "messaging", "skill-driver", "memory-driver", "config-driver"],
    drivers: [
      { kind: "skill", id: "hermes-skill" },
      { kind: "memory", id: "sqlite-fts5" },
      { kind: "config", id: "hermes-config" },
    ],
  };
}

describe("parseManifest", () => {
  it("合法 manifest 解析成功", () => {
    const r = parseManifest(validManifest());
    expect(r.ok).toBe(true);
    expect(r.data?.frameworkId).toBe("hermes");
    expect(r.data?.declaredLevel).toBe(3);
    expect(r.data?.drivers).toHaveLength(3);
    expect(typeof r.durationMs).toBe("number");
  });

  it("contractVersion 不受支持（2.x）→ E001", () => {
    const m = validManifest();
    m.contractVersion = "2.x";
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("E001");
    expect(r.error?.retryable).toBe(false);
    expect(r.error?.userHint).toBeTruthy();
  });

  it("contractVersion 缺失 → E001", () => {
    const m = validManifest() as Record<string, unknown>;
    delete m.contractVersion;
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("E001");
  });

  it("缺必填字段（displayName）→ E001", () => {
    const m = validManifest() as Record<string, unknown>;
    delete m.displayName;
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("E001");
    expect(r.error?.message).toContain("schema validation");
  });

  it("declaredLevel 越界（4）→ E001", () => {
    const m = validManifest();
    m.declaredLevel = 4;
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("E001");
  });

  it("frameworkId 非 kebab-case → E001", () => {
    const m = validManifest();
    m.frameworkId = "Hermes_X";
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("E001");
  });

  it("未知能力位 → E001", () => {
    const m = validManifest();
    m.capabilities = ["probe", "teleport"];
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("E001");
  });

  it("非对象输入 → E001 而非抛异常", () => {
    for (const input of [null, undefined, 42, "manifest", []]) {
      const r = parseManifest(input);
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("E001");
    }
  });

  it("最小合法 manifest（L0 纯观察）", () => {
    const r = parseManifest({
      frameworkId: "openclaw",
      displayName: "OpenClaw",
      contractVersion: "1.0",
      adapterVersion: "0.0.1",
      declaredLevel: 0,
      capabilities: ["probe"],
      drivers: [],
    });
    expect(r.ok).toBe(true);
    expect(r.data?.declaredLevel).toBe(0);
  });
});
