/**
 * TypeSafe Jev 客户端与 System One 判定封装：
 * 提供 Choice、Score、Noul 原语封装，以及面向记忆系统的选型顾问与质量评估，
 * 内置未配置 API Key 或网络故障时的确定性启发式平滑降级（Graceful Degradation）。
 */

import type {
  JevAdvisorRequest,
  JevAdvisorResult,
  MemoryDeployMode,
  MemoryEngineId,
} from "@butler/contract";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface JevClientOptions {
  apiKey?: string | null;
  endpoint?: string | null;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

export interface JevChoiceResult<T extends string = string> {
  choice: T;
  probabilities: Record<T, number>;
  confidence: number;
}

export interface JevScoreResult {
  score: number;
  confidence: number;
}

export interface JevNoulResult {
  probability: number;
}

export class JevClient {
  private readonly apiKey: string | null;
  private readonly endpoint: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey?.trim() || null;
    this.endpoint = (options.endpoint?.trim() || "https://api.typesafe.ai").replace(/\/+$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  get isConfigured(): boolean {
    return this.apiKey !== null && this.apiKey.length > 0;
  }

  /** Choice 原语：从候选集合中根据 state 和 instructions 判定最优分支 */
  async choice<T extends string>(params: {
    state: Record<string, unknown>;
    instructions: string;
    criteria: Record<T, string>;
  }): Promise<JevChoiceResult<T> | null> {
    if (!this.isConfigured) return null;
    try {
      const response = await this.postJson<{
        choice: T;
        probabilities?: Record<T, number>;
        confidence?: number;
      }>("/v1/choice", {
        state: params.state,
        instructions: params.instructions,
        criteria: params.criteria,
      });
      if (!response.ok || !response.data) return null;
      const data = response.data;
      return {
        choice: data.choice,
        probabilities: data.probabilities ?? ({ [data.choice]: 1.0 } as Record<T, number>),
        confidence: data.confidence ?? 0.85,
      };
    } catch {
      return null;
    }
  }

  /** Score 原语：按离散等级评定维度得分 */
  async score(params: {
    state: Record<string, unknown>;
    instructions: string;
    levels: Record<number, string>;
  }): Promise<JevScoreResult | null> {
    if (!this.isConfigured) return null;
    try {
      const response = await this.postJson<{
        score: number;
        confidence?: number;
      }>("/v1/score", {
        state: params.state,
        instructions: params.instructions,
        levels: params.levels,
      });
      if (!response.ok || !response.data) return null;
      return {
        score: response.data.score,
        confidence: response.data.confidence ?? 0.85,
      };
    } catch {
      return null;
    }
  }

  /** Noul 原语：判定某个条件是否成立的概率 (0.0 ~ 1.0) */
  async noul(params: {
    state: Record<string, unknown>;
    instructions: string;
  }): Promise<JevNoulResult | null> {
    if (!this.isConfigured) return null;
    try {
      const response = await this.postJson<{
        probability: number;
      }>("/v1/noul", {
        state: params.state,
        instructions: params.instructions,
      });
      if (!response.ok || !response.data) return null;
      return {
        probability: response.data.probability,
      };
    } catch {
      return null;
    }
  }

  /**
   * 记忆系统选型顾问：
   * 结合用户填写的业务场景、用户并发、硬件规格与偏好，
   * 优先通过 TypeSafe Jev 获得类型化决策；若未配置或异常，自动平滑回退至确定性启发式规则。
   */
  async adviseMemorySystem(req: JevAdvisorRequest): Promise<JevAdvisorResult> {
    if (this.isConfigured) {
      try {
        const candidateCriteria: Record<string, string> = {
          hindsight_docker: "本地 Docker 运行 Hindsight：适合强隐私要求、需要知识图谱关联与反思综合推理，且机器内存 >= 8GB",
          mem0_docker: "本地 Docker 运行 Mem0：适合本地自托管、高频读写、双层向量+实体检索，机器内存 >= 6GB",
          hindsight_cloud: "云端 Hindsight API：适合极深图谱推理但本地计算/内存资源受限的环境",
          mem0_cloud: "云端 Mem0 Platform API：适合生产环境跨机共享、快速接入、免本地容器维护",
          hermes_sqlite: "Hermes 原生 SQLite 记忆库：适合资源极简（<4GB 内存）、无额外依赖的轻量本地场景",
        };

        const choiceRes = await this.choice({
          state: {
            scenario: req.scenario,
            userCount: req.userCount ?? 1,
            hardware: req.hardware ?? {},
            priorities: req.priorities ?? {},
          },
          instructions:
            "评估当前 Agent 运行环境与业务场景，选出最适用的记忆后端架构组合（引擎 + 部署模式）。优先权衡隐私、机器内存容量及推理深度。",
          criteria: candidateCriteria,
        });

        if (choiceRes) {
          const parts = choiceRes.choice.split("_");
          const engine = (parts[0] ?? "hindsight") as MemoryEngineId;
          const mode = (parts[1] === "docker"
            ? "docker"
            : parts[1] === "cloud"
              ? "api"
              : "builtin") as MemoryDeployMode;

          const scoreRes = await this.score({
            state: {
              chosen: choiceRes.choice,
              hardware: req.hardware ?? {},
            },
            instructions: "评分 1-5：评估此选型在当前硬件资源下的运行适配流畅度（1=吃力/资源不足，5=完美契合/充裕）。",
            levels: {
              1: "严重资源瓶颈",
              2: "基本能跑但有内存压力",
              3: "平稳适配正常运转",
              4: "资源适配良好有冗余",
              5: "完美契合且性能充沛",
            },
          });

          return {
            engine,
            mode,
            confidence: choiceRes.confidence,
            probabilities: choiceRes.probabilities,
            hardwareFitScore: scoreRes ? scoreRes.score : 4,
            maintenanceComplexityScore: mode === "docker" ? 2 : mode === "api" ? 1 : 1,
            reason: `TypeSafe Jev 基于「${req.scenario}」场景及当前硬件配置推荐方案：${engine} (${mode})。`,
            source: "jev",
          };
        }
      } catch {
        // 异常自动平滑降级
      }
    }

    // 平滑降级：确定性启发式规则
    return this.heuristicAdvise(req);
  }

  /**
   * 启发式兜底规则：
   * 在未配置 TypeSafe API Key 或网络不可达时提供精准规则判断。
   */
  private heuristicAdvise(req: JevAdvisorRequest): JevAdvisorResult {
    const memGb = req.hardware?.memoryGb ?? 16;
    const privacy = req.priorities?.privacy ?? 4;
    const reasoning = req.priorities?.reasoningDepth ?? 4;
    const scenario = req.scenario.toLowerCase();

    // 内存极低环境（< 6GB）
    if (memGb < 6) {
      return {
        engine: "hermes",
        mode: "builtin",
        confidence: 0.9,
        probabilities: { hermes_sqlite: 0.85, mem0_cloud: 0.15 },
        hardwareFitScore: 5,
        maintenanceComplexityScore: 1,
        reason: "当前系统可用内存较小（< 6GB），规则引擎推荐使用轻量低开销的 Hermes 原生 SQLite 记忆后端。",
        source: "heuristic",
      };
    }

    // 优先深层反思与知识图谱
    if (reasoning >= 4 || scenario.includes("分析") || scenario.includes("技术") || scenario.includes("图谱")) {
      const mode: MemoryDeployMode = privacy >= 3 ? "docker" : "api";
      return {
        engine: "hindsight",
        mode,
        confidence: 0.88,
        probabilities: { hindsight_docker: 0.7, mem0_docker: 0.2, hermes_sqlite: 0.1 },
        hardwareFitScore: memGb >= 16 ? 5 : 4,
        maintenanceComplexityScore: mode === "docker" ? 2 : 1,
        reason:
          mode === "docker"
            ? "注重深度推理与数据本地隐私，且本机资源充沛（推荐本地 Docker 部署 Hindsight）。"
            : "注重深度推理，推荐使用 Hindsight 云端 API 接入模式。",
        source: "heuristic",
      };
    }

    // 默认主流推荐：Mem0 Docker
    return {
      engine: "mem0",
      mode: "docker",
      confidence: 0.85,
      probabilities: { mem0_docker: 0.65, hindsight_docker: 0.25, hermes_sqlite: 0.1 },
      hardwareFitScore: 5,
      maintenanceComplexityScore: 2,
      reason: "推荐本地 Docker 部署 Mem0：双层向量+实体检索自适应维护，兼具速度与数据私密性。",
      source: "heuristic",
    };
  }

  private async postJson<T>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; data?: T }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(`${this.endpoint}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let data: T | undefined = undefined;
      try {
        data = (await response.json()) as T;
      } catch {
        // non-json response
      }
      return {
        ok: response.ok,
        status: response.status,
        data,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
