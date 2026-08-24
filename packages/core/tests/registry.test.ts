import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/events";
import { AdapterRegistry } from "../src/registry";
import { fakeBundle, fakeManifest, makeTempDir, rmTempDir, writeManifestDir } from "./helpers";

describe("AdapterRegistry", () => {
  let tmp: string;
  let bus: EventBus;
  let registry: AdapterRegistry;

  beforeEach(() => {
    tmp = makeTempDir();
    bus = new EventBus();
    registry = new AdapterRegistry({ bus });
  });

  afterEach(() => {
    rmTempDir(tmp);
  });

  it("程序化注册成功后 get/has/list 可用", () => {
    const bundle = fakeBundle();
    const result = registry.register(bundle);
    expect(result.ok).toBe(true);

    expect(registry.has("fake-fw")).toBe(true);
    expect(registry.get("fake-fw")!.bundle).toBe(bundle);
    expect(registry.getBundle("fake-fw")).toBe(bundle);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]!.manifest.frameworkId).toBe("fake-fw");
    expect(registry.has("unknown")).toBe(false);
    expect(registry.get("unknown")).toBeUndefined();
  });

  it("重复 frameworkId 注册 → E002 拒绝", () => {
    expect(registry.register(fakeBundle()).ok).toBe(true);
    const dup = registry.register(fakeBundle());
    expect(dup.ok).toBe(false);
    expect(dup.error?.code).toBe("E002");
    expect(dup.error?.retryable).toBe(false);
    expect(registry.list()).toHaveLength(1);
  });

  it("manifest 校验不过 → E001 拒绝并广播 adapter-rejected", () => {
    const rejected: string[] = [];
    bus.on("adapter-rejected", (e) => rejected.push(e.payload.code));

    const bad = fakeBundle(fakeManifest({ contractVersion: "2.x" }));
    const result = registry.register(bad);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("E001");
    expect(registry.has("fake-fw")).toBe(false);
    expect(rejected).toEqual(["E001"]);
  });

  it("loadFromDir：合法 manifest 登记为 manifest-only 条目", () => {
    writeManifestDir(tmp, "good-fw", fakeManifest({ frameworkId: "good-fw" }));
    const result = registry.loadFromDir(tmp);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ loaded: 1, skipped: 0 });
    expect(registry.has("good-fw")).toBe(true);
    expect(registry.getBundle("good-fw")).toBeUndefined(); // 尚未接线实现
  });

  it("loadFromDir：非法 manifest 记 adapter-rejected 并跳过（不抛异常）", () => {
    const rejected: { code: string; dir?: string }[] = [];
    bus.on("adapter-rejected", (e) => rejected.push({ code: e.payload.code, dir: e.payload.dir }));

    writeManifestDir(tmp, "bad-version", fakeManifest({ frameworkId: "bad-version", contractVersion: "9.x" }));
    writeManifestDir(tmp, "bad-shape", { frameworkId: "bad-shape" }); // 缺必填字段
    writeManifestDir(tmp, "no-manifest-dir", fakeManifest()); // 会写 manifest，改为覆盖删除
    fs.rmSync(path.join(tmp, "no-manifest-dir", "manifest.json"));

    const result = registry.loadFromDir(tmp);
    expect(result.ok).toBe(true);
    expect(result.data!.skipped).toBe(3);
    expect(result.data!.loaded).toBe(0);
    expect(registry.list()).toHaveLength(0);

    const codes = rejected.map((r) => r.code).sort();
    expect(codes).toEqual(["E001", "E001", "E002"]);
    expect(rejected.every((r) => typeof r.dir === "string")).toBe(true);
  });

  it("loadFromDir：损坏 JSON 与重复 frameworkId 均跳过", () => {
    writeManifestDir(tmp, "same-id", fakeManifest({ frameworkId: "same-id" }));
    registry.loadFromDir(tmp);

    const rejected: string[] = [];
    bus.on("adapter-rejected", (e) => rejected.push(e.payload.code));

    const corruptDir = path.join(tmp, "corrupt");
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, "manifest.json"), "{ not valid json", "utf-8");

    // 重复 frameworkId（same-id 已登记；重扫 same-id 目录自身也会再次命中 E002）
    writeManifestDir(tmp, "same-id-again", fakeManifest({ frameworkId: "same-id" }));

    const result = registry.loadFromDir(tmp);
    expect(result.data!.skipped).toBe(3);
    expect([...rejected].sort()).toEqual(["E001", "E002", "E002"]);
  });

  it("loadFromDir：目录不存在 → E002 失败结果", () => {
    const result = registry.loadFromDir(path.join(tmp, "missing"));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("E002");
  });

  it("manifest-only 条目可被程序化 register 接线，接线后再次注册仍拒", () => {
    writeManifestDir(tmp, "fake-fw", fakeManifest({ frameworkId: "fake-fw" }));
    registry.loadFromDir(tmp);

    const bundle = fakeBundle(fakeManifest({ frameworkId: "fake-fw" }));
    const wired = registry.register(bundle);
    expect(wired.ok).toBe(true);
    expect(registry.getBundle("fake-fw")).toBe(bundle);
    expect(registry.get("fake-fw")!.source).toBe("dir");

    const again = registry.register(bundle);
    expect(again.ok).toBe(false);
    expect(again.error?.code).toBe("E002");
  });

  it("loadFromDir 忽略普通文件，只扫子目录", () => {
    writeManifestDir(tmp, "dir-fw", fakeManifest({ frameworkId: "dir-fw" }));
    fs.writeFileSync(path.join(tmp, "stray.json"), "{}", "utf-8");
    const result = registry.loadFromDir(tmp);
    expect(result.data).toMatchObject({ loaded: 1, skipped: 0 });
  });
});
