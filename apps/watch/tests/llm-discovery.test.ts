import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discoverHermesLlm } from "../src/llm-discovery.js";

const roots: string[] = [];

async function makeRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "butler-llm-discovery-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), content, "utf8");
  }
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("discoverHermesLlm（纯 Node 直读）", () => {
  it("识别 config.yaml 的 model 段（deepseek 场景）", async () => {
    const root = await makeRoot({
      "config.yaml": [
        "model:",
        "  base_url: https://api.deepseek.com/v1",
        "  default: deepseek-v4-flash",
        "  provider: deepseek",
        "fallback_providers: []",
      ].join("\n"),
      ".env": "DEEPSEEK_API_KEY=sk-test-123\n",
    });
    const items = await discoverHermesLlm(root);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "hermes-default",
      provider: "deepseek",
      endpoint: "https://api.deepseek.com/v1",
      model: "deepseek-v4-flash",
      apiKey: "sk-test-123",
      importable: true,
      runtimeObserved: false,
    });
  });

  it("仅有 .env 中的 OPENAI_MODEL / OPENAI_BASE_URL / key 时也可发现", async () => {
    const root = await makeRoot({
      ".env": "OPENAI_MODEL=gpt-5\nOPENAI_BASE_URL=https://api.openai.com/v1\nOPENAI_API_KEY=sk-abc\n",
    });
    const items = await discoverHermesLlm(root);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ model: "gpt-5", endpoint: "https://api.openai.com/v1", apiKey: "sk-abc" });
  });

  it("custom_providers 里与 provider 匹配的条目可补全 endpoint", async () => {
    const root = await makeRoot({
      "config.yaml": [
        "model:",
        "  provider: custom-relay",
        "  default: my-model",
        "custom_providers:",
        "  - provider: Custom-Relay",
        "    base_url: https://relay.example.com/v1",
        "    model: my-model",
      ].join("\n"),
    });
    const items = await discoverHermesLlm(root);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ endpoint: "https://relay.example.com/v1", model: "my-model" });
  });

  it("无任何模型配置时回退到运行日志观测（runtimeObserved）", async () => {
    const root = await makeRoot({
      "config.yaml": "agent:\n  max_turns: 90\n",
      "logs/agent.log": "2026-08-31 init model=deepseek-v4-flash-vision-exp turn=1\n",
    });
    const items = await discoverHermesLlm(root);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "hermes-runtime-log",
      model: "deepseek-v4-flash-vision-exp",
      runtimeObserved: true,
      importable: false,
    });
  });

  it("目录不可达且未提供 exec 时返回空列表（不抛错）", async () => {
    const items = await discoverHermesLlm(join(tmpdir(), "butler-definitely-missing-root"));
    expect(items).toEqual([]);
  });

  it("目录不可达时退回 python3 通道", async () => {
    const calls: string[][] = [];
    const exec = {
      exec: async (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              id: "hermes-default",
              source: "/home/u/.hermes",
              provider: "deepseek",
              protocol: "openai-compatible",
              endpoint: "https://api.deepseek.com/v1",
              model: "deepseek-v4-flash",
              apiKey: "sk-from-python",
              importable: true,
              runtimeObserved: false,
            },
          ]),
          stderr: "",
        };
      },
    };
    const items = await discoverHermesLlm("/home/u/.hermes", { exec });
    expect(calls[0]?.[0]).toBe("python3");
    expect(items[0]).toMatchObject({ apiKey: "sk-from-python", model: "deepseek-v4-flash" });
  });
});
