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
  TaskDiagnosisRequest,
  TaskDiagnosisResult,
  TaskRootCauseCategory,
  MessageTriageRequest,
  MessageTriageResult,
  MessageTriageCategory,
  GroupChatDispatchRequest,
  GroupChatDispatchResult,
  PeerHandoffGateRequest,
  PeerHandoffGateResult,
  BotComplianceScoreRequest,
  BotComplianceScoreResult,
  SystemOneQuestion,
  SystemOneAnswer,
  SystemOneChoiceAnswer,
  SystemOneScoreAnswer,
  SystemOneNoulAnswer,
  SystemOneResponsePayload,
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
    this.fetchFn = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  get isConfigured(): boolean {
    return this.apiKey !== null && this.apiKey.length > 0;
  }

  get isAvailable(): boolean {
    return this.isConfigured;
  }

  /**
   * System One 基础原语：向 POST /v1/systemone 提交 state 和多 typed questions
   */
  async systemOne<Q extends Record<string, SystemOneQuestion>>(params: {
    state: unknown;
    questions: Q;
    model?: string;
  }): Promise<Record<keyof Q, SystemOneAnswer> | null> {
    if (!this.isConfigured) return null;
    try {
      const response = await this.postJson<SystemOneResponsePayload>("/v1/systemone", {
        state: params.state,
        model: params.model ?? "jev-latest",
        questions: params.questions,
      });
      if (!response.ok || !response.data || !response.data.answers) return null;
      return response.data.answers as Record<keyof Q, SystemOneAnswer>;
    } catch {
      return null;
    }
  }

  /** Choice 原语：从候选集合中根据 state 和 instructions 判定最优分支 */
  async choice<T extends string>(params: {
    state: unknown;
    instructions: string | Record<string, unknown> | unknown[];
    criteria: Record<T, string | Record<string, unknown> | unknown[] | null>;
  }): Promise<JevChoiceResult<T> | null> {
    const answers = await this.systemOne({
      state: params.state,
      questions: {
        item: {
          type: "choice",
          instructions: params.instructions,
          criteria: params.criteria,
        },
      },
    });
    if (!answers || !answers.item || answers.item.type !== "choice") return null;
    const ans = answers.item as SystemOneChoiceAnswer<T>;
    return {
      choice: ans.choice,
      probabilities: ans.probabilities ?? ({ [ans.choice]: 1.0 } as Record<T, number>),
      confidence: ans.confidence ?? 0.85,
    };
  }

  /** Score 原语：按离散等级评定维度得分（criteria: string[] 有序数组） */
  async score(params: {
    state: unknown;
    instructions: string | Record<string, unknown> | unknown[];
    criteria?: Array<string | Record<string, unknown> | unknown[]>;
    levels?: Record<number, string>;
  }): Promise<JevScoreResult | null> {
    const criteria = params.criteria ?? (
      params.levels
        ? Object.keys(params.levels)
            .sort((a, b) => Number(a) - Number(b))
            .map((k) => params.levels![Number(k)])
        : []
    );
    const answers = await this.systemOne({
      state: params.state,
      questions: {
        item: {
          type: "score",
          instructions: params.instructions,
          criteria,
        },
      },
    });
    if (!answers || !answers.item || answers.item.type !== "score") return null;
    const ans = answers.item as SystemOneScoreAnswer;
    return {
      score: ans.score,
      confidence: ans.confidence ?? 0.85,
    };
  }

  /** Noul 原语：判定某个条件是否成立的概率 (0.0 ~ 1.0) */
  async noul(params: {
    state: unknown;
    instructions: string | Record<string, unknown> | unknown[];
    criteria?: {
      true?: string | Record<string, unknown> | unknown[];
      false?: string | Record<string, unknown> | unknown[];
    };
  }): Promise<JevNoulResult | null> {
    const answers = await this.systemOne({
      state: params.state,
      questions: {
        item: {
          type: "noul",
          instructions: params.instructions,
          ...(params.criteria ? { criteria: params.criteria } : {}),
        },
      },
    });
    if (!answers || !answers.item || answers.item.type !== "noul") return null;
    const ans = answers.item as SystemOneNoulAnswer;
    return {
      probability: ans.noul,
    };
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

        const answers = await this.systemOne({
          state: {
            scenario: req.scenario,
            userCount: req.userCount ?? 1,
            hardware: req.hardware ?? {},
            priorities: req.priorities ?? {},
          },
          questions: {
            recommendation: {
              type: "choice",
              instructions:
                "评估当前 Agent 运行环境与业务场景，选出最适用的记忆后端架构组合（引擎 + 部署模式）。优先权衡隐私、机器内存容量及推理深度。",
              criteria: candidateCriteria,
            },
            hardwareFit: {
              type: "score",
              instructions:
                "评分 1-5：评估在当前硬件资源（内存/CPU）和使用场景下运行适合的记忆后端的顺畅契合度（1=吃力/资源不足，5=完美契合/充裕）。",
              criteria: [
                "严重资源瓶颈",
                "基本能跑但有内存压力",
                "平稳适配正常运转",
                "资源适配良好有冗余",
                "完美契合且性能充沛",
              ],
            },
          },
        });

        if (answers && answers.recommendation?.type === "choice") {
          const choiceAns = answers.recommendation as SystemOneChoiceAnswer;
          const scoreAns = answers.hardwareFit?.type === "score"
            ? (answers.hardwareFit as SystemOneScoreAnswer)
            : null;

          const parts = choiceAns.choice.split("_");
          const engine = (parts[0] ?? "hindsight") as MemoryEngineId;
          const mode = (parts[1] === "docker"
            ? "docker"
            : parts[1] === "cloud"
              ? "api"
              : "builtin") as MemoryDeployMode;

          const rawScore = scoreAns ? scoreAns.score : 4;
          const hardwareFitScore = Math.min(5, Math.max(1, Math.round(rawScore <= 4 ? rawScore + 1 : rawScore)));

          return {
            engine,
            mode,
            confidence: choiceAns.confidence,
            probabilities: choiceAns.probabilities,
            hardwareFitScore,
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

  /**
   * 定时任务异常诊断与归因：
   * 优先通过 TypeSafe Jev 进行根因分类（Choice）与严重程度打分（Score）；
   * 未配置或异常时平滑降级至确定性启发式规则。
   */
  async diagnoseTaskError(req: TaskDiagnosisRequest): Promise<TaskDiagnosisResult> {
    if (this.isConfigured) {
      try {
        const answers = await this.systemOne({
          state: {
            taskName: req.taskName,
            exitCode: req.exitCode,
            errorSnippet: req.errorSnippet.slice(0, 800),
            durationMs: req.durationMs,
            schedule: req.schedule,
          },
          questions: {
            rootCause: {
              type: "choice",
              instructions:
                "分析该自动化任务的执行错误信息，将其归结为最精确的故障根因类别。",
              criteria: {
                credential_expired: "API Key 失效、鉴权失败、返回 401/403 或认证凭据缺失",
                rate_limited: "遭遇上游模型或通信渠道并发限制、配额耗尽或返回 429",
                syntax_or_format: "脚本语法错误、JSON 解析失败、Prompt 格式损坏或参数非法",
                timeout_or_killed: "任务执行超时被杀、内存溢出 OOM 或收到 SIGKILL/SIGTERM",
                network_or_offline: "网络不可达、DNS 解析失败、连接重置或 Hermes 网关离线",
                unknown_runtime: "其他无法从日志片断中明确归类的内部运行崩溃",
              },
            },
            severity: {
              type: "score",
              instructions:
                "评分 1-5：评估此错误对整个 Agent 系统的影响严重度（1=轻微无害，5=关键致命）。",
              criteria: [
                "偶发轻微波动，不影响核心功能",
                "局部非关键错误，建议关注",
                "单次任务失败，需注意重试",
                "高频或关键任务失败，需尽快处理",
                "致命阻断错误，系统核心功能瘫痪",
              ],
            },
          },
        });

        if (answers && answers.rootCause?.type === "choice") {
          const choiceAns = answers.rootCause as SystemOneChoiceAnswer<TaskRootCauseCategory>;
          const scoreAns = answers.severity?.type === "score"
            ? (answers.severity as SystemOneScoreAnswer)
            : null;

          const actionMap: Record<TaskRootCauseCategory, string> = {
            credential_expired: "检查并更新模型或通道的 API Key 凭据",
            rate_limited: "适当调低定时任务执行频率或等待配额恢复",
            syntax_or_format: "检查任务 Prompt 模版与输入参数格式",
            timeout_or_killed: "适当增加超时时间或拆分长耗时任务",
            network_or_offline: "检查网络连接与宿主 Hermes 网关运行状态",
            unknown_runtime: "查看任务详情中的完整运行时日志以定位故障",
          };

          const rawScore = scoreAns ? scoreAns.score : 3;
          const severity = Math.min(5, Math.max(1, Math.round(rawScore <= 4 ? rawScore + 1 : rawScore)));

          return {
            rootCause: choiceAns.choice,
            severity,
            confidence: choiceAns.confidence,
            recommendedAction: actionMap[choiceAns.choice] || "查看完整日志排查",
            explanation: `TypeSafe Jev 诊断识别为「${choiceAns.choice}」故障。`,
            source: "jev",
          };
        }
      } catch {
        // 平滑降级
      }
    }


    return this.heuristicDiagnoseTaskError(req);
  }

  /** 启发式任务错误诊断兜底规则 */
  private heuristicDiagnoseTaskError(req: TaskDiagnosisRequest): TaskDiagnosisResult {
    const text = `${req.errorSnippet || ""} exit=${req.exitCode ?? ""}`.toLowerCase();

    if (/401|403|unauthorized|invalid api key|bad credential|auth failure|forbidden/i.test(text)) {
      return {
        rootCause: "credential_expired",
        severity: 4,
        confidence: 0.92,
        recommendedAction: "检查并更新模型或通道的 API Key 凭据",
        explanation: "检测到凭据鉴权或访问被拒错误，请更新相关密钥。",
        source: "heuristic",
      };
    }

    if (/429|rate limit|quota exceeded|too many requests|resource_exhausted/i.test(text)) {
      return {
        rootCause: "rate_limited",
        severity: 3,
        confidence: 0.9,
        recommendedAction: "适当调低定时任务执行频率或等待配额恢复",
        explanation: "上游服务返回 429 限流或调用配额耗尽，建议错峰调度。",
        source: "heuristic",
      };
    }

    if (/timeout|timed out|sigkill|sigterm|exit code 137|oom|killed/i.test(text) || req.exitCode === 137) {
      return {
        rootCause: "timeout_or_killed",
        severity: 4,
        confidence: 0.88,
        recommendedAction: "适当增加超时时间或优化任务耗时",
        explanation: "任务执行超出时限或因内存不足被系统强行终止。",
        source: "heuristic",
      };
    }

    if (/econnrefused|enotfound|offline|network error|etimedout|socket hang up|connection refused/i.test(text)) {
      return {
        rootCause: "network_or_offline",
        severity: 3,
        confidence: 0.86,
        recommendedAction: "检查网络连接与宿主 Hermes 网关运行状态",
        explanation: "检测到网络断开或目标服务未就绪，建议检查网络连接。",
        source: "heuristic",
      };
    }

    if (/syntaxerror|parse error|invalid json|unexpected token/i.test(text)) {
      return {
        rootCause: "syntax_or_format",
        severity: 3,
        confidence: 0.85,
        recommendedAction: "检查任务 Prompt 模版与输入参数格式",
        explanation: "任务脚本或输出解析遇到语法错误，需修正格式。",
        source: "heuristic",
      };
    }

    return {
      rootCause: "unknown_runtime",
      severity: 2,
      confidence: 0.7,
      recommendedAction: "查看任务详情中的完整运行时日志以定位故障",
      explanation: "任务遇到未知运行异常，建议查阅完整日志详情。",
      source: "heuristic",
    };
  }

  /**
   * 即时消息分流判定：
   * 优先通过 TypeSafe Jev 判定紧急度（Noul）与业务分类（Choice）；
   * 未配置或异常时平滑降级至确定性启发式规则。
   */
  async triageMessage(req: MessageTriageRequest): Promise<MessageTriageResult> {
    if (this.isConfigured) {
      try {
        const answers = await this.systemOne({
          state: {
            channel: req.channel,
            sender: req.sender,
            summary: req.summary.slice(0, 500),
            status: req.status,
            userActiveHours: req.userActiveHours,
          },
          questions: {
            is_urgent: {
              type: "noul",
              instructions:
                "判定该即时通讯消息是否属于需要用户立即关注、人工审批或处理的紧急重要事件（1.0=必须打扰，0.0=无需打扰）。",
            },
            category: {
              type: "choice",
              instructions: "将该消息划分为对应的业务处理分类。",
              criteria: {
                approval_request: "需要人类介入审批、确认或高危操作授权",
                critical_failure: "消息投递失败、通道断开或严重故障提醒",
                task_completion: "日常定时任务顺利完成或阶段性健康报告",
                heartbeat_chatter: "系统周期心跳、通道日常闲聊或普通调试日志",
              },
            },
          },
        });

        if (answers && answers.category?.type === "choice") {
          const choiceAns = answers.category as SystemOneChoiceAnswer<MessageTriageCategory>;
          const noulAns = answers.is_urgent?.type === "noul"
            ? (answers.is_urgent as SystemOneNoulAnswer)
            : null;
          const prob = noulAns ? noulAns.noul : 0.5;

          return {
            requiresUrgentAttention:
              prob >= 0.6 || choiceAns.choice === "approval_request" || choiceAns.choice === "critical_failure",
            urgencyProbability: prob,
            category: choiceAns.choice,
            confidence: choiceAns.confidence,
            explanation: `TypeSafe Jev 分流分类为「${choiceAns.choice}」，紧急度概率 ${(prob * 100).toFixed(0)}%。`,
            source: "jev",
          };
        }
      } catch {
        // 平滑降级
      }
    }


    return this.heuristicTriageMessage(req);
  }

  /** 启发式消息分流兜底规则 */
  private heuristicTriageMessage(req: MessageTriageRequest): MessageTriageResult {
    if (req.status === "pending_approval" || req.status === "need_confirmation") {
      return {
        requiresUrgentAttention: true,
        urgencyProbability: 0.95,
        category: "approval_request",
        confidence: 0.95,
        explanation: "消息处于等待审批或用户确认状态，需要立即人工决策。",
        source: "heuristic",
      };
    }

    if (req.status === "failed") {
      return {
        requiresUrgentAttention: true,
        urgencyProbability: 0.88,
        category: "critical_failure",
        confidence: 0.9,
        explanation: "消息投递明确失败，需及时排查通道或网络故障。",
        source: "heuristic",
      };
    }

    const text = req.summary.toLowerCase();
    if (text.includes("完成") || text.includes("成功") || text.includes("success") || text.includes("done")) {
      return {
        requiresUrgentAttention: false,
        urgencyProbability: 0.2,
        category: "task_completion",
        confidence: 0.85,
        explanation: "属于例行任务完成或通知汇报，无需打扰用户。",
        source: "heuristic",
      };
    }

    return {
      requiresUrgentAttention: false,
      urgencyProbability: 0.1,
      category: "heartbeat_chatter",
      confidence: 0.8,
      explanation: "常规消息或心跳，默认不打扰。",
      source: "heuristic",
    };
  }

  /**
   * Pantheon Bot Mode 场景 1：群聊智能调度中枢 (Jev Choice)
   * 当用户在群聊中未明确 @ 任何 Bot 时，利用 Choice 原语根据职责与上下文判定由哪位 Bot 接单。
   */
  async dispatchGroupChat(req: GroupChatDispatchRequest): Promise<GroupChatDispatchResult> {
    if (!req.activeBots || req.activeBots.length === 0) {
      return {
        selectedBotId: "butler",
        confidence: 1.0,
        reason: "当前无可用 Bot，默认指派全能管家。",
        source: "heuristic",
      };
    }

    if (req.activeBots.length === 1) {
      const single = req.activeBots[0];
      return {
        selectedBotId: single.id,
        confidence: 1.0,
        reason: `群聊仅有「${single.name}」在场，直接指派。`,
        source: "heuristic",
      };
    }

    if (this.isConfigured) {
      try {
        const criteria: Record<string, string> = {};
        for (const bot of req.activeBots) {
          criteria[bot.id] = `【${bot.name}】定位：${bot.role}。职责边界：${bot.duties.join("；")}`;
        }

        const choiceRes = await this.choice<string>({
          state: {
            userMessage: req.message,
            recentSummary: req.recentSummary ?? "协同群聊交互",
            candidateBots: req.activeBots.map((b) => ({ id: b.id, name: b.name, role: b.role })),
          },
          instructions:
            "根据用户当前提问或需求指令，从候选群聊 Bot 名册中选出最契合其专业领域的唯一一位 Bot 接单响应。",
          criteria,
        });

        if (choiceRes && choiceRes.choice) {
          const matched = req.activeBots.find((b) => b.id === choiceRes.choice);
          return {
            selectedBotId: choiceRes.choice,
            confidence: choiceRes.confidence,
            probabilities: choiceRes.probabilities,
            reason: `TypeSafe Jev 基于岗位分工选定由「${matched?.name ?? choiceRes.choice}」响应。`,
            source: "jev",
          };
        }
      } catch {
        // 平滑降级至规则判定
      }
    }

    return this.heuristicDispatchGroupChat(req);
  }

  /** 群聊调度确定性启发式兜底 */
  private heuristicDispatchGroupChat(req: GroupChatDispatchRequest): GroupChatDispatchResult {
    const text = req.message.toLowerCase();
    const findBot = (keywordRegex: RegExp) =>
      req.activeBots.find(
        (b) =>
          keywordRegex.test(b.id.toLowerCase()) ||
          keywordRegex.test(b.name.toLowerCase()) ||
          keywordRegex.test(b.role.toLowerCase()),
      );

    // 1. 检查 / 代码 / 故障 / 安全 -> Inspector
    if (/(审查|代码|bug|故障|排错|修复|安全|审计|健康|日志|error|trace|fail)/i.test(text)) {
      const inspector = findBot(/inspector|审查|代码|安全/i);
      if (inspector) {
        return {
          selectedBotId: inspector.id,
          confidence: 0.88,
          reason: `识别到故障/排错/代码相关诉求，规则分流至「${inspector.name}」。`,
          source: "heuristic",
        };
      }
    }

    // 2. 检索 / 文档 / 搜索 / 简报 -> Scout
    if (/(检索|搜索|查|文档|资讯|新闻|搜|简报|search|doc|web|summary|找)/i.test(text)) {
      const scout = findBot(/scout|侦察|检索|搜索/i);
      if (scout) {
        return {
          selectedBotId: scout.id,
          confidence: 0.88,
          reason: `识别到信息检索/外部搜索诉求，规则分流至「${scout.name}」。`,
          source: "heuristic",
        };
      }
    }

    // 3. 默认管家或第一个 Bot
    const butler = findBot(/butler|管家/i) ?? req.activeBots[0];
    return {
      selectedBotId: butler.id,
      confidence: 0.8,
      reason: `常规协同任务，默认由主控「${butler.name}」承接。`,
      source: "heuristic",
    };
  }

  /**
   * Pantheon Bot Mode 场景 2：Bot 协作自主接力门禁 (Jev Noul + Choice 并发投机)
   * 判定某个 Bot 回复后是否需要触发 hermes peer 接力流水线，并内置最大 3 轮死循环熔断。
   */
  async evaluatePeerHandoff(req: PeerHandoffGateRequest): Promise<PeerHandoffGateResult> {
    // 硬熔断防线：单次级联对话轮次超过 3 轮直接终结，避免死循环消耗 Token
    const turn = req.turnCount ?? 1;
    if (turn >= 3) {
      return {
        needsHandoff: false,
        handoffProbability: 0,
        nextBotId: null,
        suggestedPrompt: null,
        reason: "已达单次流水线接力轮次硬上限 (3 轮)，触发死循环熔断保护并归还发言权给用户。",
        source: "heuristic",
      };
    }

    if (!req.availablePeerBots || req.availablePeerBots.length === 0) {
      return {
        needsHandoff: false,
        handoffProbability: 0,
        nextBotId: null,
        suggestedPrompt: null,
        reason: "群聊无其他可用协作 Bot，无法接力。",
        source: "heuristic",
      };
    }

    if (this.isConfigured) {
      try {
        const peerCriteria: Record<string, string> = {};
        for (const bot of req.availablePeerBots) {
          peerCriteria[bot.id] = `【${bot.name}】定位：${bot.role}。职责：${bot.duties.join("；")}`;
        }

        const answers = await this.systemOne({
          state: {
            currentBotId: req.currentBotId,
            botResponseSnippet: req.botResponse.slice(0, 1500),
            userGoal: req.userGoal ?? "",
            turnCount: turn,
          },
          questions: {
            needs_handoff: {
              type: "noul",
              instructions:
                "分析当前 Bot 的回复，判定当前任务是否未彻底结束且明确需要下一位专职 Bot 介入接力（例如研究员给出了日志但需要审查员排查，或分析完成需要管家执行）。若已给出最终完整方案或仅等待人类操作，必须为 false。",
              criteria: {
                true: "需要由另一位专职 Bot 接力执行后续步骤",
                false: "任务已完成、无需协作或交由用户确认",
              },
            },
            next_bot: {
              type: "choice",
              instructions: "若需接力，从可用协同 Bot 中选出最适合接棒的下一位 Bot。",
              criteria: peerCriteria,
            },
          },
        });

        if (answers && answers.needs_handoff?.type === "noul") {
          const noulAns = answers.needs_handoff as SystemOneNoulAnswer;
          const prob = noulAns.noul;
          const choiceAns = answers.next_bot?.type === "choice"
            ? (answers.next_bot as SystemOneChoiceAnswer<string>)
            : null;

          if (prob >= 0.75 && choiceAns?.choice) {
            const nextBot = req.availablePeerBots.find((b) => b.id === choiceAns.choice);
            return {
              needsHandoff: true,
              handoffProbability: prob,
              nextBotId: choiceAns.choice,
              suggestedPrompt: `请接力上一位智能体（${req.currentBotId}）的输出并继续推进：${req.botResponse.slice(0, 300)}...`,
              reason: `TypeSafe Jev 判定需由「${nextBot?.name ?? choiceAns.choice}」接力（接力概率 ${(prob * 100).toFixed(0)}%）。`,
              source: "jev",
            };
          }

          return {
            needsHandoff: false,
            handoffProbability: prob,
            nextBotId: null,
            suggestedPrompt: null,
            reason: `TypeSafe Jev 判定当前步骤已就绪，无需接力（接力概率 ${(prob * 100).toFixed(0)}%）。`,
            source: "jev",
          };
        }
      } catch {
        // 平滑降级
      }
    }

    return this.heuristicEvaluatePeerHandoff(req);
  }

  /** 接力门禁确定性启发式兜底 */
  private heuristicEvaluatePeerHandoff(req: PeerHandoffGateRequest): PeerHandoffGateResult {
    const text = req.botResponse;
    // 匹配显式 @ 或 peer 指令
    const mentionMatch = /@([a-zA-Z0-9_\u4e00-\u9fa5]+)/.exec(text);
    if (mentionMatch) {
      const targetName = mentionMatch[1].toLowerCase();
      const matchedBot = req.availablePeerBots.find(
        (b) =>
          b.id.toLowerCase() === targetName ||
          b.name.toLowerCase() === targetName ||
          targetName.includes(b.name.toLowerCase()),
      );
      if (matchedBot) {
        return {
          needsHandoff: true,
          handoffProbability: 0.95,
          nextBotId: matchedBot.id,
          suggestedPrompt: `响应上一位智能体的 @点名，继续执行相关协作任务。`,
          reason: `智能体在正文中明确 @ 了「${matchedBot.name}」，触发 peer 流水线接力。`,
          source: "heuristic",
        };
      }
    }

    return {
      needsHandoff: false,
      handoffProbability: 0.1,
      nextBotId: null,
      suggestedPrompt: null,
      reason: "回复中未包含显式接力指令，且属于阶段性结论，保持等待用户输入。",
      source: "heuristic",
    };
  }

  /**
   * Pantheon Bot Mode 场景 3：Bot 人设与安全合规审查 (Jev Score)
   * 对 Bot 的回复质量、职责边界合规度（1-5 档）进行快速打分与潜在风险检测。
   */
  async scoreBotCompliance(req: BotComplianceScoreRequest): Promise<BotComplianceScoreResult> {
    if (this.isConfigured) {
      try {
        const scoreRes = await this.score({
          state: {
            botId: req.botId,
            botRole: req.botRole,
            botDuties: req.botDuties,
            responseSnippet: req.responseContent.slice(0, 1500),
          },
          instructions:
            "评估当前 Bot 回复内容是否符合其设定的岗位职责、人设口吻，且是否在安全且负责的工程边界内（1-5 档分级）。",
          criteria: [
            "严重越权或包含未经用户许可的高危指令，人设完全崩塌",
            "偏离岗位职责，出现明显幻觉或提出不靠谱猜测",
            "基本合规，在职责范围内但回答偏单薄或稍显生硬",
            "良好合规，紧扣职责分工，论据充分且口吻专业",
            "极佳合规，人设鲜明，专业精准，完全在安全可控边界内",
          ],
        });

        if (scoreRes) {
          const score = scoreRes.score;
          const compliant = score >= 3;
          return {
            score,
            confidence: scoreRes.confidence,
            compliant,
            explanation: compliant
              ? `TypeSafe Jev 职责合规度评分 ${score}/5，表现优良。`
              : `TypeSafe Jev 警示：合规度仅 ${score}/5，可能存在人设偏离或边界模糊。`,
            source: "jev",
          };
        }
      } catch {
        // 平滑降级
      }
    }

    return this.heuristicScoreBotCompliance(req);
  }

  /** 合规审查确定性启发式兜底 */
  private heuristicScoreBotCompliance(req: BotComplianceScoreRequest): BotComplianceScoreResult {
    const text = req.responseContent;
    if (!text || text.trim() === "") {
      return {
        score: 2,
        confidence: 0.9,
        compliant: false,
        explanation: "回复内容为空，不符合正常响应预期。",
        source: "heuristic",
      };
    }

    // 危险高危破坏性指令预警
    if (/(rm\s+-rf\s+\/|mkfs\b|dd\s+if=|format\s+[c-z]:)/i.test(text)) {
      return {
        score: 1,
        confidence: 0.98,
        compliant: false,
        explanation: "检测到可能危及系统的破坏性 Shell 命令模式，合规审查判定为高危（1/5）。",
        source: "heuristic",
      };
    }

    return {
      score: 4,
      confidence: 0.85,
      compliant: true,
      explanation: "经规则安全预检，无越权或高危特征，判定合规（4/5）。",
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
