import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  JevClient,
  PRESET_BOTS,
  ensurePresetProfiles,
  listBotProfiles,
  saveBotProfile,
  deleteBotProfile,
  sanitizeBotId,
} from "../src/index.js";

describe("Pantheon Bot Mode & TypeSafe Jev System One", () => {
  describe("Bot Registry & ~/.hermes/profiles/ 同步", () => {
    it("自动初始化预设三大经典 Bot（Butler、Inspector、Scout）并落盘", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-pantheon-"));
      try {
        await ensurePresetProfiles(tmpDir);

        const profiles = await listBotProfiles(tmpDir);
        expect(profiles.length).toBe(3);
        const ids = profiles.map((p) => p.id);
        expect(ids).toContain("butler");
        expect(ids).toContain("inspector");
        expect(ids).toContain("scout");

        // 验证磁盘物理文件存在
        const inspectorSoul = await fs.readFile(
          path.join(tmpDir, "profiles", "inspector", "SOUL.md"),
          "utf8",
        );
        expect(inspectorSoul).toContain("审查员 (Inspector)");

        const scoutConfig = await fs.readFile(
          path.join(tmpDir, "profiles", "scout", "config.yaml"),
          "utf8",
        );
        expect(scoutConfig).toContain('name: "侦察员"');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("支持保存自定义 Bot 并禁止删除系统预设 Bot", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-pantheon-custom-"));
      try {
        await saveBotProfile(tmpDir, {
          id: "custom-tester",
          name: "测试专家",
          role: "自动化测试与端到端验证",
          duties: ["编写 Vitest 测试", "校验边界条件覆盖"],
        });

        const profiles = await listBotProfiles(tmpDir);
        expect(profiles.length).toBe(4);
        const tester = profiles.find((p) => p.id === "custom-tester");
        expect(tester).toBeDefined();
        expect(tester?.name).toBe("测试专家");

        // 尝试删除预设 Bot 应报错
        await expect(deleteBotProfile(tmpDir, "inspector")).rejects.toThrow(
          /Cannot delete preset bot/,
        );

        // 删除自定义 Bot
        const delRes = await deleteBotProfile(tmpDir, "custom-tester");
        expect(delRes).toBe(true);

        const afterDel = await listBotProfiles(tmpDir);
        expect(afterDel.length).toBe(3);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("JevClient 原语 1：群聊智能调度 (dispatchGroupChat)", () => {
    it("无 API Key 时通过确定性启发式规则将代码/排错诉求分流至审查员", async () => {
      const client = new JevClient(); // 未配置 API Key
      const res = await client.dispatchGroupChat({
        message: "系统网关日志里有大量 401 和连接超时，帮我排查一下根因",
        activeBots: PRESET_BOTS,
      });

      expect(res.selectedBotId).toBe("inspector");
      expect(res.source).toBe("heuristic");
      expect(res.confidence).toBeGreaterThan(0.8);
      expect(res.reason).toContain("审查员");
    });

    it("无 API Key 时将检索/搜索诉求分流至侦察员", async () => {
      const client = new JevClient();
      const res = await client.dispatchGroupChat({
        message: "查一下 Hermes Agent 最新的 Release Notes，搜索有哪些新命令",
        activeBots: PRESET_BOTS,
      });

      expect(res.selectedBotId).toBe("scout");
      expect(res.source).toBe("heuristic");
      expect(res.reason).toContain("侦察员");
    });

    it("有 API Key 时优先走 Jev Choice 原语", async () => {
      const fakeFetch = async (url: string, init?: RequestInit) => {
        return new Response(
          JSON.stringify({
            model: "jev-latest",
            answers: {
              item: {
                type: "choice",
                choice: "scout",
                confidence: 0.94,
                probabilities: { scout: 0.94, inspector: 0.04, butler: 0.02 },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const client = new JevClient({ apiKey: "test_key", fetchFn: fakeFetch });
      const res = await client.dispatchGroupChat({
        message: "汇总今天行业内的 AI 进展简报",
        activeBots: PRESET_BOTS,
      });

      expect(res.selectedBotId).toBe("scout");
      expect(res.source).toBe("jev");
      expect(res.confidence).toBe(0.94);
      expect(res.probabilities?.["scout"]).toBe(0.94);
    });
  });

  describe("JevClient 原语 2：协作接力门禁与防死循环 (evaluatePeerHandoff)", () => {
    it("达到 3 轮上限时强制死循环硬熔断并归还用户", async () => {
      const client = new JevClient({ apiKey: "test_key" });
      const res = await client.evaluatePeerHandoff({
        currentBotId: "scout",
        botResponse: "我提炼出了文档，建议 @inspector 审查代码。",
        availablePeerBots: PRESET_BOTS.filter((b) => b.id !== "scout"),
        turnCount: 3, // 已达第 3 轮
      });

      expect(res.needsHandoff).toBe(false);
      expect(res.reason).toContain("熔断保护");
      expect(res.source).toBe("heuristic");
    });

    it("正文中包含显式 @点名 时在规则层触发 peer 流水线接力", async () => {
      const client = new JevClient();
      const res = await client.evaluatePeerHandoff({
        currentBotId: "scout",
        botResponse: "外部文档已抓取完毕，相关代码变更请 @审查员 继续核查。",
        availablePeerBots: PRESET_BOTS.filter((b) => b.id !== "scout"),
        turnCount: 1,
      });

      expect(res.needsHandoff).toBe(true);
      expect(res.nextBotId).toBe("inspector");
      expect(res.source).toBe("heuristic");
      expect(res.reason).toContain("审查员");
    });

    it("有 API Key 时通过 Speculative Fan-out（Noul + Choice）判定是否接力", async () => {
      const fakeFetch = async () => {
        return new Response(
          JSON.stringify({
            model: "jev-latest",
            answers: {
              needs_handoff: { type: "noul", noul: 0.88 },
              next_bot: {
                type: "choice",
                choice: "inspector",
                confidence: 0.9,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const client = new JevClient({ apiKey: "test_key", fetchFn: fakeFetch });
      const res = await client.evaluatePeerHandoff({
        currentBotId: "butler",
        botResponse: "系统检测到异常报错，现需要审查员进行代码级分析。",
        availablePeerBots: PRESET_BOTS.filter((b) => b.id !== "butler"),
        turnCount: 1,
      });

      expect(res.needsHandoff).toBe(true);
      expect(res.nextBotId).toBe("inspector");
      expect(res.handoffProbability).toBe(0.88);
      expect(res.source).toBe("jev");
    });
  });

  describe("JevClient 原语 3：Bot 人设与合规审查 (scoreBotCompliance)", () => {
    it("检测到破坏性 Shell 指令时评分给出低分（1/5）并报警", async () => {
      const client = new JevClient();
      const res = await client.scoreBotCompliance({
        botId: "inspector",
        botRole: "代码审查员",
        botDuties: ["排查错误"],
        responseContent: "我已经帮你删掉了全部文件：sudo rm -rf /",
      });

      expect(res.score).toBe(1);
      expect(res.compliant).toBe(false);
      expect(res.explanation).toContain("破坏性 Shell 命令");
    });

    it("有 API Key 时调用 Score 原语进行多档位评估", async () => {
      const fakeFetch = async () => {
        return new Response(
          JSON.stringify({
            model: "jev-latest",
            answers: {
              item: {
                type: "score",
                score: 5,
                confidence: 0.96,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const client = new JevClient({ apiKey: "test_key", fetchFn: fakeFetch });
      const res = await client.scoreBotCompliance({
        botId: "inspector",
        botRole: "代码审查员",
        botDuties: ["排查错误"],
        responseContent: "经第一性原理分析，错误来自网关 401 鉴权令牌过期，请先刷新密钥。",
      });

      expect(res.score).toBe(5);
      expect(res.compliant).toBe(true);
      expect(res.confidence).toBe(0.96);
      expect(res.source).toBe("jev");
    });
  });
});
