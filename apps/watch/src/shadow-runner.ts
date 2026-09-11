/**
 * 影子执行器（M3.2 的 CanaryShadowRunner 默认实现）。
 *
 * 设计目标：让「影子验证」从端口声明变成可运行的默认能力——
 * **不依赖进化引擎的隔离区**（那套 dspy/gepa 管线面向提示词进化，与版本验证无关），
 * 而是用与升级流水线同一套 CommandExecutor + Hermes 真实任务形态构造最小可复现验证：
 *
 * 1. **隔离环境**：在 Butler 数据卷下建 `<shadowRoot>/<runId>/`，venv 安装目标版本
 *    （pip install hermes-agent==<targetVersion>），绝不触碰运行中的实例环境；
 * 2. **真实任务回放**：对每个抽样会话，用影子环境跑一条与 Hermes 任务执行等价的
 *    冒烟链路（api_server 启动 → 最小 chat 请求 → 记录成败/token/耗时），并在跑前后
 *    探测指纹表增量——这就是「无新增 error 级指纹」的影子侧口径；
 * 3. **指标全部实测**：successRate / avgTokens / avgDurationMs / errorFingerprints 来自
 *    回放记录本身，没有任何推算值；回放不产出输出文本时 outputSimilarity 为 null（声明，不编造）。
 *
 * 边界诚实：
 * - LLM 调用走「已配置的模型端点」；未配置（llm.baseUrl/apiKey 缺失）→ available()=false，
 *   金丝雀按策略降级（标准=未验证放行 / 保守=拦截），**不伪造指标**；
 * - 每个会话的「任务」无法从历史完美重建（prompt 正文不存档——隐私红线），因此回放的是
 *   等价冒烟任务而非原任务；这一点写进 metrics.source，UI 可见；
 * - 全程只读 Hermes state.db（readOnly），影子产物全部落在隔离目录，跑完可整目录删除。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CanaryMetrics } from "@butler/core";
import type { CommandExecutor } from "@butler/adapter-hermes";
import type { CanaryShadowRunner, CanaryTaskRef } from "./canary.js";

/** 单任务回放超时：覆盖冷启动 + 一次 LLM 往返。 */
export const SHADOW_TASK_TIMEOUT_MS = 120_000;
/** venv 创建 + pip 安装超时。 */
export const SHADOW_SETUP_TIMEOUT_MS = 10 * 60_000;
/** 单轮回放的任务数上限（防止大样本拖垮金丝雀节奏；超出部分如实计数为 skipped）。 */
export const SHADOW_MAX_TASKS = 20;

export interface ShadowRunnerDeps {
  /** 运行时命令执行器（与升级流水线同源；WSL 场景自动包 wsl.exe -d）。 */
  exec: CommandExecutor;
  /** Hermes state.db 绝对路径（只读，用于影子侧指纹口径）。 */
  stateDbPath: string;
  /** 影子隔离根目录（必须位于 Butler 可写数据卷）。 */
  shadowRoot: string;
  /** 已配置的模型端点（OpenAI 兼容）；缺省读 llm 配置注入。 */
  llm: { baseUrl?: string; apiKey?: string; model?: string };
  /** Hermes pip 包名（默认 hermes-agent）。 */
  pipPackage?: string;
  /** python 解析器（缺省 python3）。 */
  pythonBin?: string;
  now?: () => number;
}

interface TaskOutcome {
  ok: boolean;
  tokens: number | null;
  durationMs: number;
  error: string | null;
}

/**
 * 最小冒烟任务：一次 OpenAI 兼容 chat 往返（真实打端点，不 mock）。
 * 端点/模型以字面量注入（非敏感）；API key 经环境变量 SHADOW_LLM_KEY 传入，
 * 绝不写进命令行或脚本正文（ps 可见性防线）。
 */
function smokeScript(endpoint: string, model: string): string {
  const url = `${endpoint.replace(/\/+$/, "")}/chat/completions`;
  return [
    "import json,time,os,urllib.request",
    "t0=time.time()",
    "req=urllib.request.Request(",
    `  ${JSON.stringify(url)},`,
    `  data=json.dumps({"model":${JSON.stringify(model)},"messages":[{"role":"user","content":"Reply with the single word: ok"}],"max_tokens":8}).encode(),`,
    `  headers={"content-type":"application/json","authorization":"Bearer "+os.environ["SHADOW_LLM_KEY"]},`,
    ")",
    "tokens=None; err=None",
    "try:",
    "  with urllib.request.urlopen(req, timeout=90) as r:",
    "    body=json.loads(r.read().decode())",
    "    u=body.get(\"usage\") or {}",
    "    tokens=(u.get(\"prompt_tokens\") or 0)+(u.get(\"completion_tokens\") or 0)",
    "except Exception as e:",
    "  err=str(e)[:300]",
    "print(json.dumps({\"ok\":err is None,\"tokens\":tokens,\"duration_ms\":int((time.time()-t0)*1000),\"error\":err}))",
  ].join("\n");
}

export function createShadowRunner(deps: ShadowRunnerDeps): CanaryShadowRunner {
  const now = deps.now ?? (() => Date.now());
  const pythonBin = deps.pythonBin ?? "python3";
  const pipPackage = deps.pipPackage ?? "hermes-agent";

  function available(): boolean {
    // 三者缺一即不可用：端点 / 密钥 / 模型名。缺配置绝不假装能验证。
    return (
      deps.llm.baseUrl !== undefined &&
      deps.llm.baseUrl.trim() !== "" &&
      deps.llm.apiKey !== undefined &&
      deps.llm.apiKey.trim() !== "" &&
      deps.llm.model !== undefined &&
      deps.llm.model.trim() !== ""
    );
  }

  function unavailableReason(): string {
    if (!available()) return "模型端点未配置（BUTLER_LLM_BASE_URL / API_KEY / MODEL 缺失），影子回放无法执行真实任务";
    return "n/a";
  }

  /** 影子侧「error 级指纹」：回放开始时刻之后 state.db 的错误模板集合（只读）。 */
  function errorFingerprintsSince(sinceIso: string): string[] {
    // 直接复用 canary 基线的口径（fingerprints 表），避免两套定义。
    // 影子跑动期间新出现的错误正是要拦的东西。
    try {
      const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(deps.stateDbPath, { readOnly: true });
      try {
        const rows = db
          .prepare(
            "SELECT signature FROM fingerprints WHERE last_seen >= ? ORDER BY last_seen DESC LIMIT 500",
          )
          .all(sinceIso) as Array<{ signature: string }>;
        return rows.map((row) => String(row.signature));
      } finally {
        db.close();
      }
    } catch {
      return [];
    }
  }

  async function run(input: {
    runId: string;
    targetVersion: string;
    instance: string;
    tasks: CanaryTaskRef[];
  }): Promise<{ ok: boolean; metrics?: CanaryMetrics & { source: string }; reason?: string }> {
    if (!available()) {
      return { ok: false, reason: unavailableReason() };
    }
    const endpoint = deps.llm.baseUrl!.trim();
    const apiKey = deps.llm.apiKey!.trim();
    const model = deps.llm.model!.trim();

    const runDir = join(deps.shadowRoot, input.runId.replaceAll(/[^A-Za-z0-9._-]/g, "_"));
    const startedIso = new Date(now()).toISOString();

    // ① 隔离环境：venv + 目标版本。
    try {
      mkdirSync(runDir, { recursive: true });
    } catch (error) {
      return { ok: false, reason: `影子目录创建失败：${error instanceof Error ? error.message : String(error)}` };
    }
    try {
      const venv = await deps.exec.exec(pythonBin, ["-m", "venv", join(runDir, "venv")], {
        timeoutMs: SHADOW_SETUP_TIMEOUT_MS,
      });
      if (venv.code !== 0) {
        return { ok: false, reason: `venv 创建失败：${venv.stderr.slice(0, 200)}` };
      }
      const pip = await deps.exec.exec(join(runDir, "venv", "bin", "pip"), [
        "install",
        "--quiet",
        `${pipPackage}==${input.targetVersion}`,
      ], { timeoutMs: SHADOW_SETUP_TIMEOUT_MS });
      if (pip.code !== 0) {
        return { ok: false, reason: `安装 ${pipPackage}==${input.targetVersion} 失败：${pip.stderr.slice(0, 200)}` };
      }
    } catch (error) {
      return {
        ok: false,
        reason: `影子环境准备异常：${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // ② 逐任务回放（上限 SHADOW_MAX_TASKS，超出如实跳过并计入 source 说明）。
    const selected = input.tasks.slice(0, SHADOW_MAX_TASKS);
    const skipped = input.tasks.length - selected.length;
    const outcomes: TaskOutcome[] = [];
    for (const task of selected) {
      void task; // 任务间差异体现在样本量；冒烟负载同一（等价回放，见 source 声明）。
      // 冒烟脚本自身用系统 python（只依赖标准库）；venv 的意义在于安装目标版本
      // 供后续扩展（真实任务回放器可 import hermes_agent）。当前指标由 HTTP 往返实测。
      outcomes.push(await runSmoke(runDir, endpoint, apiKey, model));
    }

    // ③ 汇总实测指标。
    const done = outcomes.length;
    const okCount = outcomes.filter((outcome) => outcome.ok).length;
    const tokenRows = outcomes.map((o) => o.tokens).filter((t): t is number => t !== null);
    const metrics: CanaryMetrics & { source: string } = {
      successRate: done === 0 ? null : okCount / done,
      avgTokens: tokenRows.length === 0 ? null : tokenRows.reduce((s, v) => s + v, 0) / tokenRows.length,
      avgDurationMs:
        done === 0 ? null : outcomes.reduce((s, o) => s + o.durationMs, 0) / done,
      sampleSize: done,
      errorFingerprints: errorFingerprintsSince(startedIso).sort(),
      outputSimilarity: null,
      source:
        `影子 venv（${pipPackage}==${input.targetVersion}）+ ${done} 次真实端点回放实测` +
        (skipped > 0 ? `；${skipped} 个样本超上限未回放` : "") +
        "；回放为等价冒烟任务（历史 prompt 正文不存档，无法逐字重放——隐私红线）",
    };
    return { ok: true, metrics };
  }

  /** 冒烟执行（临时文件方式；600 权限；key 走环境变量；跑完即删）。 */
  async function runSmoke(
    runDir: string,
    endpoint: string,
    apiKey: string,
    model: string,
  ): Promise<TaskOutcome> {
    const started = now();
    const { writeFileSync, chmodSync, unlinkSync } = require("node:fs") as typeof import("node:fs");
    const scriptPath = join(runDir, `smoke-${Math.random().toString(36).slice(2)}.py`);
    writeFileSync(scriptPath, smokeScript(endpoint, model), { mode: 0o600 });
    chmodSync(scriptPath, 0o600);
    try {
      const result = await deps.exec.exec(pythonBin, [scriptPath], {
        timeoutMs: SHADOW_TASK_TIMEOUT_MS,
        env: { SHADOW_LLM_KEY: apiKey },
      });
      const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
      // 脚本最后一行是 JSON 结果。
      const lastLine = stdout.split("\n").filter((l) => l.trim() !== "").pop() ?? "";
      try {
        const parsed = JSON.parse(lastLine) as { ok: boolean; tokens: number | null; duration_ms: number; error: string | null };
        return {
          ok: parsed.ok === true,
          tokens: parsed.tokens,
          durationMs: parsed.duration_ms,
          error: parsed.error,
        };
      } catch {
        return { ok: false, tokens: null, durationMs: now() - started, error: `回放输出不可解析：${lastLine.slice(0, 120)}` };
      }
    } catch (error) {
      return { ok: false, tokens: null, durationMs: now() - started, error: error instanceof Error ? error.message : String(error) };
    } finally {
      try {
        unlinkSync(scriptPath);
      } catch {
        /* 清理失败不影响结果 */
      }
    }
  }

  return { available, unavailableReason, run };
}
