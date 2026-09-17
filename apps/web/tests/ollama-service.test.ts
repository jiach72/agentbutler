import { describe, expect, it } from "vitest";
import {
  detectHardwareProfile,
  evaluateHardwareTier,
  formatBytes,
  type HardwareProfile,
} from "../src/ollama-service.js";
import { createWebServer } from "../src/server.js";

describe("Ollama Service & Hardware Tier Engine", () => {
  it("formats bytes accurately to MB and GB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(274 * 1024 * 1024)).toBe("274.0 MB");
    expect(formatBytes(1.08 * 1024 * 1024 * 1024)).toBe("1.08 GB");
  });

  it("evaluates Tier 1 for low-memory CPU-only environment", () => {
    const hw: HardwareProfile = {
      cpu: { model: "Intel Xeon", cores: 2, logicalCores: 2 },
      memory: { totalBytes: 4 * 1024 * 1024 * 1024, totalGb: 4, freeGb: 1.5 },
      gpu: null,
      platform: "linux",
      arch: "x64",
    };
    const res = evaluateHardwareTier(hw);
    expect(res.tier).toBe(1);
    expect(res.tierLabel).toContain("入门梯队");
    // Should recommend ultra-light models
    const modelNames = res.recommendations.map((r) => r.name);
    expect(modelNames).toContain("nomic-embed-text");
    expect(modelNames).toContain("qwen2.5:0.5b");
    expect(modelNames).not.toContain("qwen2.5:7b");
  });

  it("evaluates Tier 2 for mid-memory CPU-only environment", () => {
    const hw: HardwareProfile = {
      cpu: { model: "AMD Ryzen 5", cores: 6, logicalCores: 12 },
      memory: { totalBytes: 16 * 1024 * 1024 * 1024, totalGb: 16, freeGb: 8 },
      gpu: null,
      platform: "linux",
      arch: "x64",
    };
    const res = evaluateHardwareTier(hw);
    expect(res.tier).toBe(2);
    expect(res.tierLabel).toContain("平衡梯队");
    const modelNames = res.recommendations.map((r) => r.name);
    expect(modelNames).toContain("bge-m3");
    expect(modelNames).toContain("qwen2.5:1.5b");
    expect(modelNames).toContain("qwen2.5:3b");
  });

  it("evaluates Tier 3 for 8GB VRAM dedicated GPU environment", () => {
    const hw: HardwareProfile = {
      cpu: { model: "Intel Core i9-12900H", cores: 14, logicalCores: 20 },
      memory: { totalBytes: 32 * 1024 * 1024 * 1024, totalGb: 32, freeGb: 20 },
      gpu: { detected: true, name: "NVIDIA GeForce RTX 3070", vramMb: 8192, vramGb: 8, isUnified: false },
      platform: "win32",
      arch: "x64",
    };
    const res = evaluateHardwareTier(hw);
    expect(res.tier).toBe(3);
    expect(res.tierLabel).toContain("性能梯队");
    const modelNames = res.recommendations.map((r) => r.name);
    expect(modelNames).toContain("bge-m3");
    expect(modelNames).toContain("qwen2.5:1.5b");
    expect(modelNames).toContain("qwen2.5:7b");
    expect(modelNames).toContain("deepseek-r1:1.5b");
  });

  it("evaluates Tier 4 for 16GB+ VRAM or large unified memory", () => {
    const hw: HardwareProfile = {
      cpu: { model: "Apple M3 Max", cores: 16, logicalCores: 16 },
      memory: { totalBytes: 64 * 1024 * 1024 * 1024, totalGb: 64, freeGb: 40 },
      gpu: { detected: true, name: "Apple Silicon (统一内存架构)", vramGb: 44.8, isUnified: true },
      platform: "darwin",
      arch: "arm64",
    };
    const res = evaluateHardwareTier(hw);
    expect(res.tier).toBe(4);
    expect(res.tierLabel).toContain("高阶梯队");
    const modelNames = res.recommendations.map((r) => r.name);
    expect(modelNames).toContain("qwen2.5:14b");
    expect(modelNames).toContain("deepseek-r1:7b");
  });

  it("evaluates Apple Silicon tiers appropriately across RAM sizes", () => {
    // 8GB M1/M2/M3
    const hw8: HardwareProfile = {
      cpu: { model: "Apple M2", cores: 8, logicalCores: 8 },
      memory: { totalBytes: 8 * 1024 * 1024 * 1024, totalGb: 8, freeGb: 3 },
      gpu: { detected: true, name: "Apple Silicon (统一内存架构)", vramGb: 5.6, isUnified: true },
      platform: "darwin",
      arch: "arm64",
    };
    const res8 = evaluateHardwareTier(hw8);
    expect(res8.tier).toBe(2);
    expect(res8.description).toContain("Apple Silicon");

    // 16GB M3 Pro
    const hw16: HardwareProfile = {
      cpu: { model: "Apple M3 Pro", cores: 12, logicalCores: 12 },
      memory: { totalBytes: 16 * 1024 * 1024 * 1024, totalGb: 16, freeGb: 9 },
      gpu: { detected: true, name: "Apple Silicon (统一内存架构)", vramGb: 11.2, isUnified: true },
      platform: "darwin",
      arch: "arm64",
    };
    const res16 = evaluateHardwareTier(hw16);
    expect(res16.tier).toBe(3);
    expect(res16.tierLabel).toContain("性能梯队");
    expect(res16.description).toContain("Apple Silicon 统一内存架构");
    expect(res16.recommendations.map((r) => r.name)).toContain("qwen2.5:7b");

    // 36GB M3 Max
    const hw36: HardwareProfile = {
      cpu: { model: "Apple M3 Max", cores: 14, logicalCores: 14 },
      memory: { totalBytes: 36 * 1024 * 1024 * 1024, totalGb: 36, freeGb: 22 },
      gpu: { detected: true, name: "Apple Silicon (统一内存架构)", vramGb: 25.2, isUnified: true },
      platform: "darwin",
      arch: "arm64",
    };
    const res36 = evaluateHardwareTier(hw36);
    expect(res36.tier).toBe(4);
    expect(res36.tierLabel).toContain("高阶梯队");
    expect(res36.description).toContain("大容量统一内存架构");
    expect(res36.recommendations.map((r) => r.name)).toContain("qwen2.5:14b");
  });

  it("evaluates Intel Mac CPU-only environments cleanly", () => {
    // 8GB Intel Mac
    const hwIntel8: HardwareProfile = {
      cpu: { model: "Intel Core i5", cores: 4, logicalCores: 8 },
      memory: { totalBytes: 8 * 1024 * 1024 * 1024, totalGb: 8, freeGb: 2 },
      gpu: null,
      platform: "darwin",
      arch: "x64",
    };
    const resIntel8 = evaluateHardwareTier(hwIntel8);
    expect(resIntel8.tier).toBe(1);
    expect(resIntel8.recommendations.map((r) => r.name)).toContain("qwen2.5:0.5b");

    // 16GB Intel Mac
    const hwIntel16: HardwareProfile = {
      cpu: { model: "Intel Core i7", cores: 6, logicalCores: 12 },
      memory: { totalBytes: 16 * 1024 * 1024 * 1024, totalGb: 16, freeGb: 7 },
      gpu: null,
      platform: "darwin",
      arch: "x64",
    };
    const resIntel16 = evaluateHardwareTier(hwIntel16);
    expect(resIntel16.tier).toBe(2);
    expect(resIntel16.recommendations.map((r) => r.name)).toContain("qwen2.5:1.5b");
  });

  it("detects containerized Apple Silicon Mac via BUTLER_HOST_OS and BUTLER_HOST_ARCH env vars", () => {
    const origHostOs = process.env["BUTLER_HOST_OS"];
    const origHostArch = process.env["BUTLER_HOST_ARCH"];
    try {
      process.env["BUTLER_HOST_OS"] = "Darwin";
      process.env["BUTLER_HOST_ARCH"] = "arm64";
      const hw = detectHardwareProfile();
      expect(hw.platform).toBe("darwin");
      expect(hw.arch).toBe("arm64");
      // Since BUTLER_HOST_OS=Darwin and BUTLER_HOST_ARCH=arm64, if no NVIDIA GPU is present,
      // it identifies Apple Silicon unified memory
      if (!hw.gpu?.name.includes("NVIDIA")) {
        expect(hw.gpu?.isUnified).toBe(true);
        expect(hw.gpu?.name).toContain("Apple Silicon");
      }
    } finally {
      if (origHostOs !== undefined) {
        process.env["BUTLER_HOST_OS"] = origHostOs;
      } else {
        delete process.env["BUTLER_HOST_OS"];
      }
      if (origHostArch !== undefined) {
        process.env["BUTLER_HOST_ARCH"] = origHostArch;
      } else {
        delete process.env["BUTLER_HOST_ARCH"];
      }
    }
  });

  it("exposes /api/ollama/hardware-profile endpoint via Fastify", async () => {
    const app = createWebServer({
      accessToken: "", // Loopback / test mode
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/ollama/hardware-profile",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("hardware");
    expect(body).toHaveProperty("evaluation");
    expect(body.evaluation).toHaveProperty("tier");
    expect(body.evaluation).toHaveProperty("recommendations");
    expect(Array.isArray(body.evaluation.recommendations)).toBe(true);
    await app.close();
  });

  it("exposes /api/ollama/status with degradation handling when Ollama is offline", async () => {
    const app = createWebServer({
      accessToken: "",
      ollamaUrl: "http://127.0.0.1:59999", // non-existent port
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/ollama/status",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBe(false);
    expect(body.endpoint).toBe("http://127.0.0.1:59999");
    await app.close();
  });
});
