/**
 * Agent Butler 全项目 Jev 智能治理与系统级综合审计套件
 * 基于 TypeSafe Jev 原语理念，对记忆系统、凭据中心、Docker 拓扑与安全基线进行多维度量化评估。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { JevClient } from "../src/typesafe/client.js";
import { API_CREDENTIAL_PRESETS } from "../src/api-credentials.js";

describe("TypeSafe Jev 全项目架构与安全审计", () => {
  const repoRoot = join(__dirname, "../../..");

  it("[Jev 审计 1/5] JevClient 强类型原语与平滑降级鲁棒性", async () => {
    const client = new JevClient({ apiKey: null });
    expect(client.isConfigured).toBe(false);

    // 1. 资源受限（4GB）场景审计
    const resLow = await client.adviseMemorySystem({
      scenario: "低配设备轻量运行",
      hardware: { memoryGb: 4 },
      priorities: { privacy: 5, reasoningDepth: 2 },
    });
    expect(resLow.engine).toBe("hermes");
    expect(resLow.mode).toBe("builtin");
    expect(resLow.source).toBe("heuristic");
    expect(resLow.hardwareFitScore).toBe(5);

    // 2. 深度推理知识图谱场景审计
    const resHigh = await client.adviseMemorySystem({
      scenario: "技术文档分析与跨会话反思推理",
      hardware: { memoryGb: 16 },
      priorities: { privacy: 5, reasoningDepth: 5 },
    });
    expect(resHigh.engine).toBe("hindsight");
    expect(resHigh.mode).toBe("docker");
    expect(resHigh.source).toBe("heuristic");
    expect(resHigh.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("[Jev 审计 2/5] 凭据安全、预设完整性与脱敏审查", () => {
    const typesafePreset = API_CREDENTIAL_PRESETS.find((p) => p.id === "preset-typesafe");
    expect(typesafePreset).toBeDefined();
    expect(typesafePreset?.envVar).toBe("TYPESAFE_API_KEY");
    expect(typesafePreset?.category).toBe("llm");
    expect(typesafePreset?.provider).toBe("typesafe");

    const hindsightPreset = API_CREDENTIAL_PRESETS.find((p) => p.id === "preset-hindsight");
    expect(hindsightPreset).toBeDefined();
    expect(hindsightPreset?.envVar).toBe("HINDSIGHT_API_KEY");

    // 预设不允许明文暴露任何默认 key
    for (const p of API_CREDENTIAL_PRESETS) {
      expect((p as any).apiKey).toBeUndefined();
    }
  });

  it("[Jev 审计 3/5] Docker 编排网络回环隔离与数据卷独立性审查", () => {
    const dockerComposePath = join(repoRoot, "docker-compose.yml");
    expect(existsSync(dockerComposePath)).toBe(true);
    const content = readFileSync(dockerComposePath, "utf-8");

    // 核心安全规则：记忆服务端口默认必须且只能绑定 127.0.0.1 回环
    expect(content).toMatch(/127\.0\.0\.1.*9177.*:9177/);
    expect(content).toMatch(/127\.0\.0\.1.*8888.*:8888/);
    expect(content).not.toContain('"0.0.0.0:9177:9177"');
    expect(content).not.toContain('"0.0.0.0:8888:8888"');

    // 独立持久化命名卷定义
    expect(content).toContain("hindsight-data:");
    expect(content).toContain("mem0-data:");

    // 检查是否具备按需 profile
    expect(content).toContain("- memory-hindsight");
    expect(content).toContain("- memory-mem0");
  });

  it("[Jev 审计 4/5] 顶栏与安全基线文案去焦虑化审查", () => {
    const layoutPath = join(repoRoot, "ui/src/components/Layout.tsx");
    const layoutContent = readFileSync(layoutPath, "utf-8");

    // 严禁出现恐吓式的“任何人都可以访问”
    expect(layoutContent).not.toContain("任何人都可以访问");
    expect(layoutContent).toContain("仅本地访问");

    const serverPath = join(repoRoot, "apps/web/src/server.ts");
    const serverContent = readFileSync(serverPath, "utf-8");
    expect(serverContent).not.toContain("同一网络内的任何人都能操作你的 AI，请立即处理");
    expect(serverContent).toContain("建议配置访问口令保护");
  });

  it("[Jev 审计 5/5] 前端记忆中心一行 3 个紧凑栅格布局审查", () => {
    const memoryCenterPath = join(repoRoot, "ui/src/pages/memory/MemoryCenterPage.tsx");
    const content = readFileSync(memoryCenterPath, "utf-8");

    // 必须配置为 md={8}（一行 3 个卡片）
    expect(content).toContain("md={8}");
    // 必须支持 isTab 属性供嵌套渲染
    expect(content).toContain("isTab?: boolean");
  });
});
