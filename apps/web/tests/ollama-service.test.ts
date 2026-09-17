import { describe, expect, it } from "vitest";
import {
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
