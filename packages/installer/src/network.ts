/**
 * 网络逐源探测与国内镜像切换。
 *
 * 每个源（docker-registry / pypi / npm / model-endpoints）定义一组候选：
 * 官方优先，不可达时按序切换镜像；全部不可达时给出代理建议 guidance。
 * 探测用 HEAD（失败回退 GET）+ 5s 超时；只要收到任意 HTTP 响应
 * （含 Docker Registry 常见的 401 质询）即视为可达。
 *
 * fetch 可注入，测试不触网。
 */

/** 探测超时（毫秒）。 */
export const PROBE_TIMEOUT_MS = 5000;

export type ProbeMethod = "HEAD" | "GET";

/** 可注入的探测 fetch：收到响应返回 status，网络错误/超时抛异常。 */
export type ProbeFetch = (url: string, init: { method: ProbeMethod; timeoutMs: number }) => Promise<{ status: number }>;

export async function defaultProbeFetch(
  url: string,
  init: { method: ProbeMethod; timeoutMs: number },
): Promise<{ status: number }> {
  const res = await fetch(url, {
    method: init.method,
    signal: AbortSignal.timeout(init.timeoutMs),
    redirect: "manual",
  });
  return { status: res.status };
}

export type SourceId = "docker-registry" | "pypi" | "npm" | "model-endpoints";

/** 单个探测候选（官方或镜像）。 */
export interface ProbeCandidate {
  id: string;
  url: string;
  kind: "official" | "mirror";
}

/** 单个源的定义：官方 + 镜像候选（官方优先），blocking 表示是否阻断安装。 */
export interface ProbeSource {
  id: SourceId | string;
  label: string;
  candidates: ProbeCandidate[];
  /** 模型端点等失败仅提示、不阻断安装。 */
  blocking: boolean;
  /** 全部不可达时的引导文案（缺省用通用代理建议）。 */
  guidance?: string;
}

/** 单个源的探测结论。 */
export interface SourcePlan {
  id: string;
  label: string;
  /** 选中的候选 id（"official" 或镜像 id）；全部失败为 null。 */
  chosen: string | null;
  chosenUrl: string | null;
  officialReachable: boolean;
  mirrorUsed: boolean;
  allFailed: boolean;
  blocking: boolean;
  /** 仅 allFailed 时给出。 */
  guidance?: string;
}

/** 全源探测结论。 */
export interface NetworkPlan {
  results: SourcePlan[];
}

/** 全部失败时的通用建议（spec 指定文案）。 */
export const DEFAULT_ALL_FAILED_GUIDANCE = "建议设置 HTTPS_PROXY 或手动配置镜像";

/** 默认模型端点探测列表（可注入覆盖）。 */
export const DEFAULT_MODEL_ENDPOINTS = ["https://api.openai.com/v1/models", "https://dashscope.aliyuncs.com"];

/** 构造默认源清单（官方 + 国内镜像）；modelEndpoints 可配置覆盖。 */
export function buildDefaultSources(options: { modelEndpoints?: string[] } = {}): ProbeSource[] {
  const modelEndpoints = options.modelEndpoints ?? DEFAULT_MODEL_ENDPOINTS;
  const modelCandidates: ProbeCandidate[] = modelEndpoints.map((url, index) => ({
    id: index === 0 ? "official" : `endpoint-${index + 1}`,
    url,
    kind: index === 0 ? "official" : "mirror",
  }));
  return [
    {
      id: "docker-registry",
      label: "Docker 镜像仓库",
      candidates: [
        { id: "official", url: "https://registry-1.docker.io/v2/", kind: "official" },
        { id: "daocloud", url: "https://docker.m.daocloud.io/v2/", kind: "mirror" },
        { id: "1ms", url: "https://docker.1ms.run/v2/", kind: "mirror" },
      ],
      blocking: true,
      guidance: "Docker Hub 官方与镜像源均不可达：建议设置 HTTPS_PROXY 或手动配置 /etc/docker/daemon.json 的 registry-mirrors",
    },
    {
      id: "pypi",
      label: "PyPI 包源",
      candidates: [
        { id: "official", url: "https://pypi.org/simple/", kind: "official" },
        { id: "aliyun", url: "https://mirrors.aliyun.com/pypi/simple/", kind: "mirror" },
        { id: "tuna", url: "https://pypi.tuna.tsinghua.edu.cn/simple/", kind: "mirror" },
      ],
      blocking: true,
      guidance: "PyPI 官方与镜像源均不可达：建议设置 HTTPS_PROXY 或手动配置 pip 的 index-url",
    },
    {
      id: "npm",
      label: "npm 包源",
      candidates: [
        { id: "official", url: "https://registry.npmjs.org/", kind: "official" },
        { id: "npmmirror", url: "https://registry.npmmirror.com/", kind: "mirror" },
      ],
      blocking: true,
      guidance: "npm 官方与镜像源均不可达：建议设置 HTTPS_PROXY 或运行 npm config set registry https://registry.npmmirror.com/",
    },
    {
      id: "model-endpoints",
      label: "模型端点",
      candidates: modelCandidates,
      blocking: false,
      guidance: "模型端点不可达（不阻断安装）：建议设置 HTTPS_PROXY 或在 ~/.agent-butler/env 配置可达的 BUTLER_LLM_BASE_URL",
    },
  ];
}

/** 探测单个 URL 是否可达：HEAD 失败（网络层）回退 GET；收到任意响应即算可达。 */
async function probeReachable(url: string, fetcher: ProbeFetch): Promise<boolean> {
  for (const method of ["HEAD", "GET"] as const) {
    try {
      await fetcher(url, { method, timeoutMs: PROBE_TIMEOUT_MS });
      return true;
    } catch {
      // 网络错误/超时：尝试下一种方法
    }
  }
  return false;
}

/** 逐源探测：官方优先，不可达按序切镜像，全失败给 guidance。 */
export async function probeSources(sources: ProbeSource[], fetcher: ProbeFetch = defaultProbeFetch): Promise<NetworkPlan> {
  const results: SourcePlan[] = [];
  for (const source of sources) {
    // 强制官方优先（即使调用方把镜像排在前面）
    const ordered = [
      ...source.candidates.filter((c) => c.kind === "official"),
      ...source.candidates.filter((c) => c.kind !== "official"),
    ];
    let chosen: ProbeCandidate | null = null;
    let officialReachable = false;
    for (const candidate of ordered) {
      const reachable = await probeReachable(candidate.url, fetcher);
      if (candidate.kind === "official") {
        officialReachable = reachable;
      }
      if (reachable) {
        chosen = candidate;
        break;
      }
    }
    const allFailed = chosen === null;
    results.push({
      id: source.id,
      label: source.label,
      chosen: chosen?.id ?? null,
      chosenUrl: chosen?.url ?? null,
      officialReachable,
      mirrorUsed: chosen !== null && chosen.kind === "mirror",
      allFailed,
      blocking: source.blocking,
      guidance: allFailed ? (source.guidance ?? DEFAULT_ALL_FAILED_GUIDANCE) : undefined,
    });
  }
  return { results };
}

/** 从计划中取某个源的结论（不存在时返回 undefined，如 --skip-network）。 */
export function findSourcePlan(plan: NetworkPlan, id: string): SourcePlan | undefined {
  return plan.results.find((r) => r.id === id);
}
