import { describe, expect, it } from "vitest";
import { USAGE, main, parseArgs, renderReport } from "../src/main.js";
import { runInstaller } from "../src/install.js";
import { fakeExec, fakeProbeFetch } from "./helpers.js";

const FULL_ENV: Record<string, string> = {
  BUTLER_TELEGRAM_BOT_TOKEN: "t",
  BUTLER_TELEGRAM_CHAT_ID: "1",
  BUTLER_SMTP_HOST: "h",
  BUTLER_SMTP_PORT: "465",
  BUTLER_SMTP_FROM: "a@b.c",
  BUTLER_SMTP_TO: "d@e.f",
  BUTLER_LLM_API_KEY: "k",
  BUTLER_LLM_BASE_URL: "https://llm.example/",
};

describe("parseArgs 手写参数解析", () => {
  it("无参数 → 缺省 host 形态、所有开关 false", () => {
    const args = parseArgs([]);
    expect(args).toEqual({ form: "host", dryRun: false, skipNetwork: false, secretsOnly: false, help: false });
  });

  it("--form docker 与 --form=host 两种写法", () => {
    expect(parseArgs(["--form", "docker"]).form).toBe("docker");
    expect(parseArgs(["--form=host"]).form).toBe("host");
  });

  it("布尔开关：--dry-run/--skip-network/--secrets-only/--help", () => {
    const args = parseArgs(["--dry-run", "--skip-network", "--secrets-only", "--help"]);
    expect(args.dryRun).toBe(true);
    expect(args.skipNetwork).toBe(true);
    expect(args.secretsOnly).toBe(true);
    expect(args.help).toBe(true);
  });

  it("--form 非法值 → error", () => {
    expect(parseArgs(["--form", "bogus"]).error).toContain("host 或 docker");
    expect(parseArgs(["--form=docker2"]).error).toBeTruthy();
  });

  it("--form 缺值 → error", () => {
    expect(parseArgs(["--form"]).error).toBeTruthy();
  });

  it("未知参数 → error", () => {
    expect(parseArgs(["--wat"]).error).toContain("未知参数");
  });

  it("USAGE 包含全部选项说明", () => {
    expect(USAGE).toContain("--form host|docker");
    expect(USAGE).toContain("--dry-run");
    expect(USAGE).toContain("--skip-network");
    expect(USAGE).toContain("--secrets-only");
  });
});

describe("main CLI 入口", () => {
  it("--help → 打印用法并返回 0", async () => {
    const code = await main(["--help"]);
    expect(code).toBe(0);
  });

  it("参数错误 → 返回 1", async () => {
    const code = await main(["--form", "oops"]);
    expect(code).toBe(1);
  });

  it("--secrets-only 且密钥齐全 → 返回 0", async () => {
    const { exec } = fakeExec();
    const code = await main(["--secrets-only"], { env: FULL_ENV, exec, fetch: fakeProbeFetch(() => true) });
    expect(code).toBe(0);
  });

  it("安装存在失败步骤 → 返回 1（hermes 安装失败示例）", async () => {
    const { exec } = fakeExec((command) =>
      command === "bash" ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: "", stderr: "" },
    );
    const code = await main(["--form", "host"], { env: FULL_ENV, exec, fetch: fakeProbeFetch(() => true) });
    expect(code).toBe(1);
  });

  it("dry-run docker 形态 → 返回 0", async () => {
    const { exec } = fakeExec();
    const code = await main(["--form", "docker", "--dry-run", "--skip-network"], { env: FULL_ENV, exec, fetch: fakeProbeFetch(() => true) });
    expect(code).toBe(0);
  });
});

describe("renderReport 人类可读报告", () => {
  it("渲染各阶段分区与失败步骤", async () => {
    const { exec } = fakeExec((command) =>
      command === "bash" ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: "", stderr: "" },
    );
    const report = await runInstaller({ form: "host", exec, fetch: fakeProbeFetch(() => true), env: {}, repoDir: "/tmp/repo" });
    const text = renderReport(report);
    expect(text).toContain("[平台]");
    expect(text).toContain("[网络]");
    expect(text).toContain("[密钥]");
    expect(text).toContain("[安装步骤]");
    expect(text).toContain("[fail] hermes-install");
    expect(text).toContain("[结果] 存在失败步骤");
    expect(text).toContain("[后续步骤]");
  });
});
