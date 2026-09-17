/**
 * Ollama 本地模型服务管理与动态硬件自适应推荐引擎。
 *
 * 功能点：
 * 1. 动态硬件探测（detectHardwareProfile）：实时获取宿主机 CPU、内存 RAM、GPU/显存（NVIDIA / Apple Silicon）；
 * 2. 算力分级与自适应推荐（evaluateHardwareTier）：根据真实硬件判定梯队（Tier 1~4），动态生成记忆/探针推荐模型；
 * 3. Ollama 客户端（OllamaService）：健康探活（/api/version）、模型列表（/api/tags）、异步拉取与进度跟踪（/api/pull）、模型删除。
 */
import { execSync } from "node:child_process";
import os from "node:os";

export interface HardwareProfile {
  cpu: {
    model: string;
    cores: number;
    logicalCores: number;
  };
  memory: {
    totalBytes: number;
    totalGb: number;
    freeGb: number;
  };
  gpu: {
    detected: boolean;
    name: string;
    vramMb?: number;
    vramGb?: number;
    isUnified?: boolean;
  } | null;
  platform: string;
  arch: string;
}

export interface RecommendedModel {
  name: string;
  tag: string;
  fullName: string;
  category: "embedding" | "probe" | "extraction" | "chat" | "reasoning";
  categoryLabel: string;
  sizeDisplay: string;
  reason: string;
  highlight?: boolean;
}

export interface HardwareEvaluation {
  tier: 1 | 2 | 3 | 4;
  tierLabel: string;
  hardwareSummary: string;
  description: string;
  recommendations: RecommendedModel[];
}

export interface OllamaModelItem {
  name: string;
  model: string;
  size: number;
  sizeFormatted: string;
  modifiedAt: string;
  digest: string;
  details?: {
    format?: string;
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface PullProgress {
  name: string;
  status: string;
  completed: number;
  total: number;
  percentage: number;
  error?: string;
  updatedAt: number;
}

/** 格式化字节大小为可读字符串（MB / GB）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

/** 动态探测当前宿主机客观硬件信息。 */
export function detectHardwareProfile(): HardwareProfile {
  const cpus = os.cpus() || [];
  const logicalCores = cpus.length;
  const cpuModel = cpus[0]?.model?.trim() || "Unknown CPU";

  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const totalGb = Math.round((totalBytes / (1024 * 1024 * 1024)) * 10) / 10;
  const freeGb = Math.round((freeBytes / (1024 * 1024 * 1024)) * 10) / 10;

  let gpu: HardwareProfile["gpu"] = null;

  // 1. 尝试探测 NVIDIA GPU
  try {
    const stdout = execSync("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits", {
      timeout: 1500,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const line = stdout.trim().split("\n")[0];
    if (line) {
      const parts = line.split(",").map((s) => s.trim());
      const gpuName = parts[0] || "NVIDIA GPU";
      const vramMb = parts[1] ? parseInt(parts[1], 10) : undefined;
      const vramGb = vramMb ? Math.round((vramMb / 1024) * 10) / 10 : undefined;
      gpu = {
        detected: true,
        name: gpuName,
        vramMb,
        vramGb,
        isUnified: false,
      };
    }
  } catch {
    // 无 nvidia-smi 或无 NVIDIA GPU
  }

  // 2. 若未检测到 NVIDIA，检查 Apple Silicon 统一内存
  if (!gpu && process.platform === "darwin" && process.arch === "arm64") {
    const unifiedVramGb = Math.round(totalGb * 0.7 * 10) / 10;
    gpu = {
      detected: true,
      name: "Apple Silicon (统一内存架构)",
      vramGb: unifiedVramGb,
      isUnified: true,
    };
  }

  return {
    cpu: {
      model: cpuModel,
      cores: Math.max(1, Math.floor(logicalCores / 2)),
      logicalCores,
    },
    memory: {
      totalBytes,
      totalGb,
      freeGb,
    },
    gpu,
    platform: process.platform,
    arch: process.arch,
  };
}

/** 依据硬件信息分级评估设备算力梯队，并动态生成专属推荐模型。 */
export function evaluateHardwareTier(hw: HardwareProfile): HardwareEvaluation {
  const ramGb = hw.memory.totalGb;
  const vramGb = hw.gpu?.vramGb ?? 0;
  const hasDedicatedGpu = Boolean(hw.gpu?.detected && !hw.gpu?.isUnified);
  const isAppleSilicon = Boolean(hw.gpu?.detected && hw.gpu?.isUnified);

  let tier: 1 | 2 | 3 | 4 = 1;
  let tierLabel = "入门梯队 (极轻量 CPU 模式)";
  let description = "当前设备未检测到支持的独显或系统内存 ≤ 8GB。建议运行 0.5B ~ 1.5B 极轻量模型，保障系统零负担稳定运行。";

  if (vramGb >= 14 || (isAppleSilicon && ramGb >= 32) || ramGb >= 64) {
    tier = 4;
    tierLabel = "高阶梯队 (大算力加速模式)";
    description = "检测到高显存独立显卡或大容量统一内存，支持流畅运行 7B ~ 14B 参数模型，具备出色的复杂逻辑与多任务能力。";
  } else if (vramGb >= 6 || (isAppleSilicon && ramGb >= 16) || (hasDedicatedGpu && vramGb >= 6)) {
    tier = 3;
    tierLabel = "性能梯队 (GPU 全显存加速模式)";
    description = "检测到独立显卡 (≥ 6GB 显存)，轻量与 7B 量化模型可完全载入显存全速推理 (>50~100 tokens/s)。";
  } else if (ramGb >= 12 || vramGb >= 4) {
    tier = 2;
    tierLabel = "平衡梯队 (轻量增强模式)";
    description = "检测到充裕内存 (≥ 12GB) 或入门级显卡，可流畅支持 1.5B ~ 3B 级别模型进行精准事实抽取与向量召回。";
  }

  // 动态构建模型推荐清单
  const recommendations: RecommendedModel[] = [];

  // 向量模型推荐
  if (tier >= 2) {
    recommendations.push({
      name: "bge-m3",
      tag: "latest",
      fullName: "bge-m3:latest",
      category: "embedding",
      categoryLabel: "记忆向量",
      sizeDisplay: "1.08 GB",
      reason: "长文本语义召回黄金标准，中文/多语言检索首选",
      highlight: true,
    });
  }
  recommendations.push({
    name: "nomic-embed-text",
    tag: "latest",
    fullName: "nomic-embed-text:latest",
    category: "embedding",
    categoryLabel: "极速向量",
    sizeDisplay: "274 MB",
    reason: "超轻量文本向量模型，毫秒级响应，几乎不占资源",
    highlight: tier === 1,
  });

  // 健康探针模型推荐
  recommendations.push({
    name: "qwen2.5:0.5b",
    tag: "latest",
    fullName: "qwen2.5:0.5b",
    category: "probe",
    categoryLabel: "巡检探针",
    sizeDisplay: "398 MB",
    reason: "毫秒级连通性自检，全天候巡检 0 成本，显存占用 < 500MB",
    highlight: tier <= 2,
  });

  // 事实抽取与记忆管理模型
  recommendations.push({
    name: "qwen2.5:1.5b",
    tag: "latest",
    fullName: "qwen2.5:1.5b",
    category: "extraction",
    categoryLabel: "事实抽取",
    sizeDisplay: "1.0 GB",
    reason: "高性价比甜点位，严格遵循 JSON/Markdown 提取对话事实",
    highlight: tier >= 2,
  });

  if (tier >= 2) {
    recommendations.push({
      name: "qwen2.5:3b",
      tag: "latest",
      fullName: "qwen2.5:3b",
      category: "extraction",
      categoryLabel: "深度抽取",
      sizeDisplay: "1.9 GB",
      reason: "上下文理解更深入，适合较长对话的结构化记忆归档",
    });
  }

  // 通用与推理思考模型
  if (tier >= 3) {
    recommendations.push({
      name: "qwen2.5:7b",
      tag: "latest",
      fullName: "qwen2.5:7b",
      category: "chat",
      categoryLabel: "通用智能体",
      sizeDisplay: "4.7 GB",
      reason: "全功能本地大模型，适合复杂任务规划与中文四段式总结",
      highlight: true,
    });
    recommendations.push({
      name: "deepseek-r1:1.5b",
      tag: "latest",
      fullName: "deepseek-r1:1.5b",
      category: "reasoning",
      categoryLabel: "轻量思考",
      sizeDisplay: "1.1 GB",
      reason: "包含思维链（CoT）深度推理，轻量快速",
    });
  }

  if (tier >= 4) {
    recommendations.push({
      name: "qwen2.5:14b",
      tag: "latest",
      fullName: "qwen2.5:14b",
      category: "chat",
      categoryLabel: "高阶智能体",
      sizeDisplay: "9.0 GB",
      reason: "卓越的代码、指令遵循与推理综合能力",
    });
    recommendations.push({
      name: "deepseek-r1:7b",
      tag: "latest",
      fullName: "deepseek-r1:7b",
      category: "reasoning",
      categoryLabel: "深度推理",
      sizeDisplay: "4.7 GB",
      reason: "高阶数学与逻辑推理模型，深度反思与规划",
    });
  }

  // 构建硬件摘要信息
  const gpuPart = hw.gpu?.detected
    ? `${hw.gpu.name}${hw.gpu.vramGb ? ` (${hw.gpu.vramGb}GB)` : ""}`
    : "未检测到独显 (CPU 计算)";
  const hardwareSummary = `CPU: ${hw.cpu.logicalCores} 线程 · 内存: ${hw.memory.totalGb} GB · 显卡: ${gpuPart}`;

  return {
    tier,
    tierLabel,
    hardwareSummary,
    description,
    recommendations,
  };
}

/** Ollama 服务交互客户端类。 */
export class OllamaService {
  private activePull: PullProgress | null = null;
  private pullAbortController: AbortController | null = null;

  /** 获取服务健康状态（优先 GET /api/version，回退 GET /）。 */
  async getStatus(endpoint: string): Promise<{ available: boolean; version?: string; endpoint: string; error?: string }> {
    const cleanUrl = endpoint.replace(/\/+$/, "");
    try {
      const res = await fetch(`${cleanUrl}/api/version`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = (await res.json()) as { version?: string };
        return { available: true, version: data.version || "running", endpoint: cleanUrl };
      }
      // 回退根路径探测
      const rootRes = await fetch(`${cleanUrl}/`, {
        signal: AbortSignal.timeout(3000),
      });
      if (rootRes.ok) {
        return { available: true, version: "running", endpoint: cleanUrl };
      }
      return { available: false, endpoint: cleanUrl, error: `HTTP ${res.status}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { available: false, endpoint: cleanUrl, error: msg };
    }
  }

  /** 获取已下载的本地模型列表（GET /api/tags）。 */
  async getModels(endpoint: string): Promise<{ ok: boolean; models: OllamaModelItem[]; error?: string }> {
    const cleanUrl = endpoint.replace(/\/+$/, "");
    try {
      const res = await fetch(`${cleanUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return { ok: false, models: [], error: `HTTP ${res.status}` };
      }
      const data = (await res.json()) as { models?: Array<Record<string, unknown>> };
      const rawList = Array.isArray(data.models) ? data.models : [];

      const models: OllamaModelItem[] = rawList.map((item) => {
        const name = String(item.name || "");
        const model = String(item.model || name);
        const size = typeof item.size === "number" ? item.size : 0;
        const modifiedRaw = typeof item.modified_at === "string" ? item.modified_at : "";
        let modifiedAt = "";
        if (modifiedRaw) {
          try {
            const d = new Date(modifiedRaw);
            modifiedAt = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
          } catch {
            modifiedAt = modifiedRaw.slice(0, 10);
          }
        }
        return {
          name,
          model,
          size,
          sizeFormatted: formatBytes(size),
          modifiedAt,
          digest: String(item.digest || ""),
          details: item.details as OllamaModelItem["details"],
        };
      });

      return { ok: true, models };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, models: [], error: msg };
    }
  }

  /** 触发后台拉取模型任务（POST /api/pull）。 */
  async pullModel(endpoint: string, modelName: string): Promise<{ ok: boolean; message: string }> {
    const cleanName = modelName.trim();
    if (!cleanName) {
      return { ok: false, message: "模型名称不能为空" };
    }

    if (this.activePull && this.activePull.name === cleanName && this.activePull.status !== "failed" && this.activePull.status !== "success") {
      return { ok: true, message: "该模型正在下载中" };
    }

    const cleanUrl = endpoint.replace(/\/+$/, "");
    this.pullAbortController?.abort();
    this.pullAbortController = new AbortController();

    this.activePull = {
      name: cleanName,
      status: "starting",
      completed: 0,
      total: 0,
      percentage: 0,
      updatedAt: Date.now(),
    };

    // 异步执行拉取并流式处理进度
    (async () => {
      try {
        const res = await fetch(`${cleanUrl}/api/pull`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: cleanName, stream: true }),
          signal: this.pullAbortController?.signal,
        });

        if (!res.ok || !res.body) {
          this.activePull = {
            name: cleanName,
            status: "failed",
            completed: 0,
            total: 0,
            percentage: 0,
            error: `下载发起失败: HTTP ${res.status}`,
            updatedAt: Date.now(),
          };
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const event = JSON.parse(trimmed) as {
                status?: string;
                completed?: number;
                total?: number;
                error?: string;
              };
              if (event.error) {
                this.activePull = {
                  name: cleanName,
                  status: "failed",
                  completed: 0,
                  total: 0,
                  percentage: 0,
                  error: event.error,
                  updatedAt: Date.now(),
                };
                return;
              }

              const status = event.status || "downloading";
              const completed = typeof event.completed === "number" ? event.completed : 0;
              const total = typeof event.total === "number" ? event.total : 0;
              const percentage = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;

              this.activePull = {
                name: cleanName,
                status,
                completed,
                total,
                percentage,
                updatedAt: Date.now(),
              };

              if (status === "success") {
                this.activePull.percentage = 100;
              }
            } catch {
              // 忽略单行解析失败
            }
          }
        }

        if (this.activePull && this.activePull.status !== "failed") {
          this.activePull.status = "success";
          this.activePull.percentage = 100;
          this.activePull.updatedAt = Date.now();
        }
      } catch (err) {
        if (this.activePull) {
          const msg = err instanceof Error ? err.message : String(err);
          this.activePull = {
            ...this.activePull,
            status: "failed",
            error: msg,
            updatedAt: Date.now(),
          };
        }
      }
    })();

    return { ok: true, message: `开始拉取模型 ${cleanName}` };
  }

  /** 获取当前活跃拉取进度。 */
  getPullStatus(): PullProgress | null {
    return this.activePull;
  }

  /** 删除模型（DELETE /api/delete）。 */
  async deleteModel(endpoint: string, modelName: string): Promise<{ ok: boolean; message: string }> {
    const cleanUrl = endpoint.replace(/\/+$/, "");
    try {
      const res = await fetch(`${cleanUrl}/api/delete`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: modelName }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        return { ok: true, message: `已成功删除模型 ${modelName}` };
      }
      return { ok: false, message: `删除失败: HTTP ${res.status}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `删除错误: ${msg}` };
    }
  }
}

export const defaultOllamaService = new OllamaService();
