import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALL_FAILED_GUIDANCE,
  DEFAULT_MODEL_ENDPOINTS,
  buildDefaultSources,
  findSourcePlan,
  probeSources,
  type ProbeFetch,
  type ProbeSource,
} from "../src/network.js";
import { fakeProbeFetch } from "./helpers.js";

const SOURCES = buildDefaultSources();

function byId(id: string): ProbeSource {
  const source = SOURCES.find((s) => s.id === id);
  if (source === undefined) {
    throw new Error(`missing source fixture: ${id}`);
  }
  return source;
}

describe("probeSources 逐源探测与镜像切换", () => {
  it("官方可达 → 选择官方、不切镜像、不探测后续镜像", async () => {
    const fetcher = fakeProbeFetch((url) => url.includes("pypi.org"));
    const plan = await probeSources([byId("pypi")], fetcher);
    const pypi = plan.results[0]!;
    expect(pypi.chosen).toBe("official");
    expect(pypi.officialReachable).toBe(true);
    expect(pypi.mirrorUsed).toBe(false);
    expect(pypi.allFailed).toBe(false);
    expect(pypi.guidance).toBeUndefined();
    // 官方命中即止：镜像 URL 从未被探测
    expect(fetcher.calls.map((c) => c.url)).toEqual(["https://pypi.org/simple/"]);
  });

  it("官方超时、镜像可达 → 切镜像并标记 mirrorUsed", async () => {
    const fetcher = fakeProbeFetch((url) => url.includes("mirrors.aliyun.com"));
    const plan = await probeSources([byId("pypi")], fetcher);
    const pypi = plan.results[0]!;
    expect(pypi.officialReachable).toBe(false);
    expect(pypi.chosen).toBe("aliyun");
    expect(pypi.chosenUrl).toBe("https://mirrors.aliyun.com/pypi/simple/");
    expect(pypi.mirrorUsed).toBe(true);
    expect(pypi.allFailed).toBe(false);
  });

  it("官方第一个镜像也挂 → 顺延到第二个镜像", async () => {
    const fetcher = fakeProbeFetch((url) => url.includes("docker.1ms.run"));
    const plan = await probeSources([byId("docker-registry")], fetcher);
    const registry = plan.results[0]!;
    expect(registry.chosen).toBe("1ms");
    expect(registry.mirrorUsed).toBe(true);
  });

  it("HEAD 网络失败但 GET 成功 → 仍视为可达（HEAD/GET 回退）", async () => {
    const fetcher: ProbeFetch = async (url, init) => {
      if (init.method === "HEAD") {
        throw new Error("HEAD blocked");
      }
      return { status: Number.parseInt(url.slice(-1)) || 200 };
    };
    const plan = await probeSources(
      [{ id: "t", label: "T", candidates: [{ id: "official", url: "https://t.example/1", kind: "official" }], blocking: true }],
      fetcher,
    );
    expect(plan.results[0]!.chosen).toBe("official");
  });

  it("全部失败 → allFailed + 代理建议 guidance", async () => {
    const fetcher = fakeProbeFetch(() => false);
    const plan = await probeSources([byId("npm")], fetcher);
    const npm = plan.results[0]!;
    expect(npm.allFailed).toBe(true);
    expect(npm.chosen).toBeNull();
    expect(npm.chosenUrl).toBeNull();
    expect(npm.mirrorUsed).toBe(false);
    expect(npm.guidance).toContain("HTTPS_PROXY");
    expect(npm.guidance).toContain("npmmirror");
  });

  it("缺省 guidance 为 spec 指定文案", () => {
    expect(DEFAULT_ALL_FAILED_GUIDANCE).toBe("建议设置 HTTPS_PROXY 或手动配置镜像");
  });

  it("模型端点全部失败不阻断：blocking=false 且 plan 正常返回", async () => {
    const fetcher = fakeProbeFetch((url) => url.includes("registry-1.docker.io"));
    const plan = await probeSources([byId("docker-registry"), byId("model-endpoints")], fetcher);
    const model = findSourcePlan(plan, "model-endpoints")!;
    expect(model.allFailed).toBe(true);
    expect(model.blocking).toBe(false);
    // docker registry 官方命中，模型端点失败不抛异常、不影响其它源
    expect(findSourcePlan(plan, "docker-registry")!.chosen).toBe("official");
  });

  it("探测超时固定 5s 并透传给 fetch", async () => {
    const fetcher = fakeProbeFetch(() => true);
    await probeSources([byId("npm")], fetcher);
    expect(fetcher.calls.every((c) => c.timeoutMs === 5000)).toBe(true);
  });

  it("官方优先：即使镜像排在候选前面也先探测官方", async () => {
    const source: ProbeSource = {
      id: "x",
      label: "X",
      candidates: [
        { id: "m1", url: "https://m1.example/", kind: "mirror" },
        { id: "official", url: "https://official.example/", kind: "official" },
      ],
      blocking: true,
    };
    const fetcher = fakeProbeFetch(() => true);
    const plan = await probeSources([source], fetcher);
    expect(plan.results[0]!.chosen).toBe("official");
    expect(fetcher.calls[0]?.url).toBe("https://official.example/");
  });

  it("buildDefaultSources：模型端点列表可配置", () => {
    expect(DEFAULT_MODEL_ENDPOINTS).toEqual(["https://api.openai.com/v1/models", "https://dashscope.aliyuncs.com"]);
    const custom = buildDefaultSources({ modelEndpoints: ["https://llm.internal.example/v1/models"] });
    const model = custom.find((s) => s.id === "model-endpoints")!;
    expect(model.candidates).toHaveLength(1);
    expect(model.candidates[0]).toMatchObject({ id: "official", url: "https://llm.internal.example/v1/models" });
    // 其余源保持官方 + 国内镜像候选
    expect(custom.find((s) => s.id === "docker-registry")!.candidates.map((c) => c.url)).toEqual([
      "https://registry-1.docker.io/v2/",
      "https://docker.m.daocloud.io/v2/",
      "https://docker.1ms.run/v2/",
    ]);
  });
});
