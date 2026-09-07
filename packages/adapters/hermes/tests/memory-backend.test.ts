/**
 * 记忆后端检测测试：显式 env > 目录标记 > 默认假设的三级判定，
 * 以及 normalize 对空值/未知值的回落（未知配置不得把默认实例误判为外部后端）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectMemoryBackend,
  normalizeMemoryBackendConfig,
} from "../src/memory-backend.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hermes-membk-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("detectMemoryBackend", () => {
  it("无任何标记 → 默认 hermes（source=default）", () => {
    expect(detectMemoryBackend(root)).toEqual({
      backend: "hermes",
      source: "default",
      detail: "未发现外部记忆系统标记，按默认 SQLite 记忆库处理",
    });
  });

  it("存在 hindsight/config.json → hindsight（source=marker）", () => {
    mkdirSync(join(root, "hindsight"), { recursive: true });
    writeFileSync(join(root, "hindsight", "config.json"), "{}");
    const detection = detectMemoryBackend(root);
    expect(detection.backend).toBe("hindsight");
    expect(detection.source).toBe("marker");
    expect(detection.detail).toContain("hindsight/config.json");
  });

  it("存在 mem0/config.yaml → mem0（source=marker）", () => {
    mkdirSync(join(root, "mem0"), { recursive: true });
    writeFileSync(join(root, "mem0", "config.yaml"), "provider: mem0\n");
    expect(detectMemoryBackend(root)).toMatchObject({ backend: "mem0", source: "marker" });
  });

  it("显式声明优先于标记（声明 hermes 时即便有 hindsight 标记也按默认库）", () => {
    mkdirSync(join(root, "hindsight"), { recursive: true });
    writeFileSync(join(root, "hindsight", "config.json"), "{}");
    expect(detectMemoryBackend(root, { configured: "hermes" })).toMatchObject({
      backend: "hermes",
      source: "env",
    });
    expect(detectMemoryBackend(root, { configured: "hindsight" })).toMatchObject({
      backend: "hindsight",
      source: "env",
    });
  });

  it("auto 且 hindsight 标记优先于 mem0 标记（列表顺序即优先级）", () => {
    mkdirSync(join(root, "hindsight"), { recursive: true });
    writeFileSync(join(root, "hindsight", "config.json"), "{}");
    mkdirSync(join(root, "mem0"), { recursive: true });
    writeFileSync(join(root, "mem0", "config.json"), "{}");
    expect(detectMemoryBackend(root).backend).toBe("hindsight");
  });
});

describe("normalizeMemoryBackendConfig", () => {
  it("合法值原样通过；大小写与首尾空白归一", () => {
    expect(normalizeMemoryBackendConfig("hermes")).toBe("hermes");
    expect(normalizeMemoryBackendConfig(" Hindsight ")).toBe("hindsight");
    expect(normalizeMemoryBackendConfig("MEM0")).toBe("mem0");
    expect(normalizeMemoryBackendConfig("auto")).toBe("auto");
  });

  it("空值/未知值回落 auto（自动检测），不猜测具体后端", () => {
    expect(normalizeMemoryBackendConfig(undefined)).toBe("auto");
    expect(normalizeMemoryBackendConfig("")).toBe("auto");
    expect(normalizeMemoryBackendConfig("meemo")).toBe("auto");
  });
});
