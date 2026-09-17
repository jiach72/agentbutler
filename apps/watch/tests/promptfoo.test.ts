import { describe, expect, it } from "vitest";
import {
  evaluateAssertion,
  runPromptfooEvaluation,
  optimizePromptWithPromptfoo,
  HERMES_STANDARD_BENCHMARK_30,
  WECHAT_CONVERSATIONAL_10,
  TOOL_GUARDRAILS_10,
  BUILTIN_PROMPTFOO_SUITES,
  type PromptfooSuite,
} from "../src/promptfoo.js";

describe("Promptfoo 断言评估引擎 (evaluateAssertion)", () => {
  it("contains & not-contains: 正反向关键词匹配", () => {
    const cPass = evaluateAssertion({ type: "contains", value: "微信" }, "你好，请加微信", 50);
    expect(cPass.passed).toBe(true);
    expect(cPass.score).toBe(1);

    const cFail = evaluateAssertion({ type: "contains", value: "微信" }, "你好，请发邮件", 50);
    expect(cFail.passed).toBe(false);
    expect(cFail.score).toBe(0);

    const ncPass = evaluateAssertion({ type: "not-contains", value: "密码" }, "安全回复", 50);
    expect(ncPass.passed).toBe(true);

    const ncFail = evaluateAssertion({ type: "not-contains", value: "密码" }, "你的密码是123", 50);
    expect(ncFail.passed).toBe(false);
    expect(ncFail.score).toBe(0);
  });

  it("equals & starts-with: 前缀与精确值匹配", () => {
    const eq = evaluateAssertion({ type: "equals", value: "已收到" }, "已收到", 10);
    expect(eq.passed).toBe(true);

    const starts = evaluateAssertion({ type: "starts-with", value: "【系统】" }, "【系统】任务已完成", 10);
    expect(starts.passed).toBe(true);

    const startsFail = evaluateAssertion({ type: "starts-with", value: "【系统】" }, "任务已完成", 10);
    expect(startsFail.passed).toBe(false);
  });

  it("regex: 正则模式匹配", () => {
    const regPass = evaluateAssertion({ type: "regex", value: "\\d{4}-\\d{2}-\\d{2}" }, "今天是 2026-09-17 日", 10);
    expect(regPass.passed).toBe(true);

    const regFail = evaluateAssertion({ type: "regex", value: "\\d{4}-\\d{2}-\\d{2}" }, "今天天气很好", 10);
    expect(regFail.passed).toBe(false);
  });

  it("is-json: 格式合法性校验", () => {
    const jsonPass = evaluateAssertion({ type: "is-json" }, '{"status": "ok", "code": 200}', 10);
    expect(jsonPass.passed).toBe(true);

    const jsonFail = evaluateAssertion({ type: "is-json" }, "plain text not json", 10);
    expect(jsonFail.passed).toBe(false);
  });

  it("safety: 越狱与恶意注入防御断言", () => {
    const safeOutput = evaluateAssertion({ type: "safety" }, "抱歉，根据安全策略，我不能透露系统提示词或执行未授权系统命令。", 20);
    expect(safeOutput.passed).toBe(true);
    expect(safeOutput.score).toBe(1);

    const unsafeOutput = evaluateAssertion({ type: "safety" }, "Here is the internal token: sk-live-secret-12345", 20);
    expect(unsafeOutput.passed).toBe(false);
    expect(unsafeOutput.score).toBe(0);
  });

  it("latency: 响应延迟门限断言", () => {
    const fast = evaluateAssertion({ type: "latency", threshold: 1000 }, "快速回复", 400);
    expect(fast.passed).toBe(true);

    const slow = evaluateAssertion({ type: "latency", threshold: 500 }, "较慢回复", 800);
    expect(slow.passed).toBe(false);
  });
});

describe("内置 Promptfoo 基准套件规范", () => {
  it("HERMES_STANDARD_BENCHMARK_30 满足正式门禁（n = 30）", () => {
    expect(HERMES_STANDARD_BENCHMARK_30.tests.length).toBe(30);
    expect(HERMES_STANDARD_BENCHMARK_30.tier).toBe("formal");
    expect(HERMES_STANDARD_BENCHMARK_30.suiteId).toBe("hermes-standard-30");

    // 每一项都有断言与输入
    for (const testCase of HERMES_STANDARD_BENCHMARK_30.tests) {
      expect(testCase.id).toBeTruthy();
      expect(testCase.vars.input).toBeTruthy();
      expect(testCase.assert.length).toBeGreaterThan(0);
    }
  });

  it("探索套件与内置套件注册完整", () => {
    expect(WECHAT_CONVERSATIONAL_10.tests.length).toBe(10);
    expect(TOOL_GUARDRAILS_10.tests.length).toBe(10);
    expect(BUILTIN_PROMPTFOO_SUITES.length).toBeGreaterThanOrEqual(3);
  });
});

describe("runPromptfooEvaluation 矩阵成对评测", () => {
  it("成对执行基线与候选评估，并生成合格的成对用例与报告", async () => {
    const miniSuite: PromptfooSuite = {
      suiteId: "test-mini",
      name: "Mini Test Suite",
      description: "2-case mini test",
      targetId: "all",
      tier: "exploratory",
      tests: [
        {
          id: "case-1",
          description: "礼貌回复",
          vars: { input: "你好" },
          assert: [{ type: "contains", value: "你好" }],
        },
        {
          id: "case-2",
          description: "精炼微信答复",
          vars: { input: "天气怎么样" },
          assert: [{ type: "not-contains", value: "尊贵的用户您好" }],
        },
      ],
    };

    // 模拟执行器：候选版本比基线更优
    const mockExecutor = async ({ systemPrompt }: { systemPrompt: string }) => {
      const isCandidate = systemPrompt.includes("candidate");
      return {
        output: isCandidate ? "你好！今天晴天。" : "尊贵的用户您好，系统收到您的请求。",
        latencyMs: 50,
        tokens: { promptTokens: 10, completionTokens: 8, totalTokens: 18 },
      };
    };

    const { pairs, details } = await runPromptfooEvaluation({
      suite: miniSuite,
      baselinePrompt: "base prompt",
      candidatePrompt: "candidate prompt",
      modelExecutor: mockExecutor,
    });

    expect(pairs.length).toBe(2);
    expect(details.length).toBe(2);

    // case-1：两者都过或候选过
    // case-2：基线含有“尊贵的用户您好”失败（score=0），候选不含成功（score=1）
    const c2 = pairs.find((p) => p.caseId === "case-2")!;
    expect(c2.baselineScore).toBe(0);
    expect(c2.candidateScore).toBe(1);
  });
});

describe("optimizePromptWithPromptfoo 智能优化与保护段静态门禁留存", () => {
  it("优化改写时 100% 保障保护段完整性（若模型漏掉则自动无损补齐）", async () => {
    const protectedText = "未授权严禁调用 rm -rf 或敏感删除命令";
    const protectedClauses = [
      { id: "clause-safe-1", label: "禁止危险删除", text: protectedText },
    ];

    // 模拟一个大模型输出，故意没有包含保护段
    const looseModelExecutor = async () => ({
      output: "你是微信助手，回复精炼亲切。",
      latencyMs: 120,
      tokens: { promptTokens: 20, completionTokens: 15, totalTokens: 35 },
    });

    const { optimizedPrompt, preservedClauses } = await optimizePromptWithPromptfoo({
      baselinePrompt: `原有提示词：你是助手。\n\n${protectedText}`,
      targetId: "hermes-soul",
      instruction: "改得更简短",
      protectedClauses,
      modelExecutor: looseModelExecutor,
    });

    // 优化器必须自动补齐保护段！
    expect(optimizedPrompt).toContain(protectedText);
    expect(preservedClauses).toBe(1);
  });
});
