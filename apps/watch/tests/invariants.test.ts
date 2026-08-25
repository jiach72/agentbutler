import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSecurityService } from "../src/invariants.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "butler-invariants-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("M7 配置不变式与密钥权限", () => {
  it("开放策略没有名单限制 → 不通过", async () => {
    writeFileSync(join(root, "config.yaml"), "open_policy: true\n", "utf8");
    const view = await createSecurityService({ hermesRoot: root }).status();
    const check = view.invariants.find((item) => item.id === "open-policy-whitelist");
    expect(check?.status).toBe("fail");
  });

  it("开放策略伴随名单限制 → 通过", async () => {
    writeFileSync(
      join(root, "config.yaml"),
      "open_policy: true\nallowed_users: [u1, u2]\n",
      "utf8",
    );
    const view = await createSecurityService({ hermesRoot: root }).status();
    const check = view.invariants.find((item) => item.id === "open-policy-whitelist");
    expect(check?.status).toBe("pass");
  });

  it("密钥没有接口地址 → 提醒；补上地址 → 通过", async () => {
    writeFileSync(join(root, ".env"), "OPENAI_API_KEY=sk-test\n", "utf8");
    const missing = await createSecurityService({ hermesRoot: root }).status();
    expect(missing.invariants.find((item) => item.id === "key-endpoint-pairing")?.status).toBe(
      "warn",
    );

    writeFileSync(
      join(root, ".env"),
      "OPENAI_API_KEY=sk-test\nOPENAI_BASE_URL=https://api.openai.com\n",
      "utf8",
    );
    const paired = await createSecurityService({ hermesRoot: root }).status();
    expect(paired.invariants.find((item) => item.id === "key-endpoint-pairing")?.status).toBe(
      "pass",
    );
  });

  it("密钥文件权限：0600 安全，0644 记为风险", async () => {
    writeFileSync(join(root, ".env"), "OPENAI_API_KEY=sk-test\n", "utf8");
    writeFileSync(join(root, "auth.json"), "{\"token\":\"x\"}", "utf8");
    chmodSync(join(root, ".env"), 0o600);
    chmodSync(join(root, "auth.json"), 0o644);
    const view = await createSecurityService({ hermesRoot: root }).status();

    expect(view.totalSecretFiles).toBe(2);
    if (process.platform === "win32") {
      expect(view.insecureSecretFiles).toBe(0);
      expect(view.secrets.every((secret) => secret.mode === "—" && secret.secure)).toBe(true);
      return;
    }
    expect(view.insecureSecretFiles).toBe(1);
    expect(view.secrets.find((s) => s.rel === ".env")?.secure).toBe(true);
    expect(view.secrets.find((s) => s.rel === "auth.json")?.secure).toBe(false);
  });

  it("配置发生变化时 refresh 在 30 秒轮询使用的同一路径触发回调", async () => {
    const changes: string[][] = [];
    writeFileSync(join(root, "config.yaml"), "platforms: {}\n", "utf8");
    const service = createSecurityService({
      hermesRoot: root,
      onInvariantChange: (view) => {
        changes.push(view.invariants.filter((item) => item.status === "fail").map((item) => item.id));
      },
    });

    await service.refresh();
    writeFileSync(join(root, "config.yaml"), "open_policy: true\n", "utf8");
    await service.refresh();

    expect(changes).toEqual([["open-policy-whitelist"]]);
    service.stop();
  });
});
