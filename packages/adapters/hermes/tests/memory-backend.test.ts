/**
 * 记忆后端检测测试：显式 env > 目录标记 > 默认假设的三级判定，
 * 以及 normalize 对空值/未知值的回落（未知配置不得把默认实例误判为外部后端）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectMemoryBackend,
  normalizeMemoryBackendConfig,
  listSupportedMemorySystems,
  previewMemoryBackendChange,
  applyMemoryBackendChange,
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

  it("config.yaml 中配置了 mcp_servers.hindsight → hindsight（source=config）", () => {
    writeFileSync(
      join(root, "config.yaml"),
      "mcp_servers:\n  hindsight:\n    url: http://127.0.0.1:9177/mcp/\n",
    );
    const detection = detectMemoryBackend(root);
    expect(detection.backend).toBe("hindsight");
    expect(detection.source).toBe("config");
    expect(detection.detail).toContain("hindsight MCP 记忆服务");
  });

  it("config.yaml 中配置了 mcp_servers.mem0 → mem0（source=config）", () => {
    writeFileSync(
      join(root, "config.yaml"),
      "mcp_servers:\n  mem0:\n    url: http://127.0.0.1:8888\n",
    );
    const detection = detectMemoryBackend(root);
    expect(detection.backend).toBe("mem0");
    expect(detection.source).toBe("config");
    expect(detection.detail).toContain("mem0 MCP 记忆服务");
  });

  it("支持本地 markers 如 hindsight-local.env / hindsight-venv / hindsight-local.pid", () => {
    writeFileSync(join(root, "hindsight-local.env"), "PORT=9177\n");
    expect(detectMemoryBackend(root)).toMatchObject({
      backend: "hindsight",
      source: "marker",
    });
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

describe("listSupportedMemorySystems", () => {
  it("默认环境下返回全部预设系统，原生 SQLite 为 active", () => {
    const systems = listSupportedMemorySystems(root);
    expect(systems.length).toBeGreaterThanOrEqual(4);
    const hermesSys = systems.find((s) => s.id === "hermes");
    expect(hermesSys?.active).toBe(true);
    expect(hermesSys?.currentMode).toBe("builtin");

    const hindsightSys = systems.find((s) => s.id === "hindsight");
    expect(hindsightSys?.active).toBe(false);
  });

  it("当存在 hindsight/config.json 且包含 9177 时识别为 active 且 mode 为 docker", () => {
    mkdirSync(join(root, "hindsight"), { recursive: true });
    writeFileSync(
      join(root, "hindsight", "config.json"),
      JSON.stringify({ url: "http://127.0.0.1:9177" })
    );
    const systems = listSupportedMemorySystems(root);
    const hindsightSys = systems.find((s) => s.id === "hindsight");
    expect(hindsightSys?.active).toBe(true);
    expect(hindsightSys?.currentMode).toBe("docker");
  });
});

describe("previewMemoryBackendChange & applyMemoryBackendChange", () => {
  it("预览切换到 Hindsight Docker 时生成 Diff 和目标文件", () => {
    writeFileSync(join(root, "config.yaml"), "version: 1\n");
    const preview = previewMemoryBackendChange(root, {
      engineId: "hindsight",
      deployMode: "docker",
      customEndpoint: "http://127.0.0.1:9177",
    });

    expect(preview.targetFiles.length).toBeGreaterThanOrEqual(2);
    const configDiff = preview.diffs.find((d) => d.file === "config.yaml");
    expect(configDiff).toBeDefined();
    expect(configDiff?.newContent).toContain("mcp_servers");
    expect(configDiff?.newContent).toContain("hindsight");

    const hindsightDiff = preview.diffs.find((d) => d.file.includes("hindsight"));
    expect(hindsightDiff).toBeDefined();
  });

  it("应用配置更改时自动生成备份，并原子落盘", () => {
    writeFileSync(join(root, "config.yaml"), "initial_version: 1\n");
    const res = applyMemoryBackendChange(root, {
      engineId: "hindsight",
      deployMode: "docker",
      customEndpoint: "http://127.0.0.1:9177",
    });

    expect(res.success).toBe(true);
    expect(res.backupPaths.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(res.backupPaths[0]!)).toBe(true);

    const updatedConfig = readFileSync(join(root, "config.yaml"), "utf-8");
    expect(updatedConfig).toContain("mcp_servers");
    expect(updatedConfig).toContain("hindsight");
  });
});

