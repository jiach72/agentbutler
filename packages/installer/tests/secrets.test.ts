import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSecrets, defaultEnvPath, writeEnvTemplate, type SecretGroup } from "../src/secrets.js";
import { makeTempDir, rmTempDir } from "./helpers.js";

const FULL_ENV: Record<string, string> = {
  BUTLER_TELEGRAM_BOT_TOKEN: "tg-token",
  BUTLER_TELEGRAM_CHAT_ID: "123456",
  BUTLER_SMTP_HOST: "smtp.qq.com",
  BUTLER_SMTP_PORT: "465",
  BUTLER_SMTP_FROM: "butler@example.com",
  BUTLER_SMTP_TO: "ops@example.com",
  BUTLER_LLM_API_KEY: "sk-test",
  BUTLER_LLM_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
};

describe("checkSecrets 密钥逐项校验", () => {
  it("全部就绪 → present + allPresent", () => {
    const report = checkSecrets(FULL_ENV);
    expect(report.allPresent).toBe(true);
    expect(report.missingGroups).toEqual([]);
    expect(report.groups.map((g) => `${g.id}:${g.status}`)).toEqual(["telegram:present", "smtp:present", "llm:present"]);
    for (const group of report.groups) {
      expect(group.items.every((item) => item.present)).toBe(true);
      expect(group.guidance).toBe("");
    }
  });

  it("部分缺失 → missing 状态与缺失键列表", () => {
    const report = checkSecrets({ ...FULL_ENV, BUTLER_SMTP_PORT: "", BUTLER_LLM_API_KEY: undefined });
    expect(report.allPresent).toBe(false);
    const smtp = report.groups.find((g) => g.id === "smtp")!;
    expect(smtp.status).toBe("missing");
    expect(smtp.missingKeys).toEqual(["BUTLER_SMTP_PORT"]);
    const llm = report.groups.find((g) => g.id === "llm")!;
    expect(llm.missingKeys).toEqual(["BUTLER_LLM_API_KEY"]);
  });

  it("空白字符串视为缺失", () => {
    const report = checkSecrets({ ...FULL_ENV, BUTLER_TELEGRAM_BOT_TOKEN: "   " });
    const telegram = report.groups.find((g) => g.id === "telegram")!;
    expect(telegram.status).toBe("missing");
    expect(telegram.missingKeys).toEqual(["BUTLER_TELEGRAM_BOT_TOKEN"]);
  });

  it("引导文案：缺失项 + 获取说明 + 写入位置 + export 示例", () => {
    const report = checkSecrets({});
    const telegram = report.groups.find((g) => g.id === "telegram")!;
    expect(telegram.guidance).toContain("BUTLER_TELEGRAM_BOT_TOKEN");
    expect(telegram.guidance).toContain("@BotFather");
    expect(telegram.guidance).toContain(report.envPath);
    expect(telegram.guidance).toContain("export BUTLER_TELEGRAM_BOT_TOKEN=<值> BUTLER_TELEGRAM_CHAT_ID=<值>");
  });

  it("envPath 指向 ~/.agent-butler/env", () => {
    expect(defaultEnvPath().endsWith(path.join(".agent-butler", "env"))).toBe(true);
  });

  it("清单可注入扩展", () => {
    const custom: SecretGroup[] = [
      {
        id: "custom",
        feature: "自定义功能",
        items: [{ key: "BUTLER_CUSTOM_KEY", label: "自定义键", hint: "从示例平台获取" }],
      },
    ];
    const report = checkSecrets({}, custom);
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]!.missingKeys).toEqual(["BUTLER_CUSTOM_KEY"]);
    expect(report.groups[0]!.guidance).toContain("从示例平台获取");
  });
});

describe("writeEnvTemplate env 模板生成", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir();
  });

  afterEach(() => {
    rmTempDir(tmp);
  });

  it("生成含注释、键默认留空的模板，且与落盘内容一致", () => {
    const file = path.join(tmp, "sub", "env");
    const content = writeEnvTemplate(file);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe(content);
    // 所有键都留空
    for (const key of Object.keys(FULL_ENV)) {
      expect(content).toMatch(new RegExp(`^${key}=$`, "m"));
    }
    // 含分组与获取方式注释
    expect(content).toContain("# ===== Telegram 告警通知 =====");
    expect(content).toContain("@BotFather");
    expect(content).toContain("不含任何真实密钥");
  });

  it("模板不落任何真实密钥值", () => {
    const content = writeEnvTemplate(path.join(tmp, "env"));
    // 任何键行都不得带值（键= 后为空）
    expect(content).not.toMatch(/^BUTLER_[A-Z_]+=.+$/m);
    // 不包含样例真实值（注释中的示例域名除外，此处只用不会出现在提示文案中的特征值）
    for (const secret of ["tg-token", "sk-test", "ops@example.com", "butler@example.com", "123456"]) {
      expect(content.includes(secret)).toBe(false);
    }
  });
});
