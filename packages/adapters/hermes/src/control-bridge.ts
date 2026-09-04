import { readFileSync } from "node:fs";

export type HermesControlAction =
  | "status"
  | "start-hermes"
  | "stop-hermes"
  | "restart-hermes"
  | "cleanup-orphan-gateways";

export interface HermesControlBridgeOptions {
  baseUrl: string;
  tokenFile: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface HermesControlBridgeStatus {
  active: boolean;
  unit: string;
}

export interface HermesControlBridgeCleanupResult extends HermesControlBridgeStatus {
  cleanedPids: number[];
  mainPid: number | null;
}

/**
 * 访问宿主控制桥的最小客户端。请求体只有固定 action，绝不接受任意命令或参数。
 * token 每次请求从文件读取，避免把长期凭据缓存到适配器对象中。
 */
export class HermesControlBridgeClient {
  private readonly baseUrl: string;
  private readonly tokenFile: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HermesControlBridgeOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.tokenFile = options.tokenFile;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async status(): Promise<HermesControlBridgeStatus> {
    return this.requestStatus("status");
  }

  async run(action: Exclude<HermesControlAction, "status" | "cleanup-orphan-gateways">): Promise<HermesControlBridgeStatus> {
    return this.requestStatus(action);
  }

  /** 容器场景由宿主 bridge 清理固定模式的孤儿网关进程，绝不传递任意 PID 或命令。 */
  async cleanupOrphanGateways(): Promise<HermesControlBridgeCleanupResult> {
    const body = await this.request("cleanup-orphan-gateways");
    if (!isCleanupResult(body)) throw new Error("Hermes control bridge cleanup response is invalid");
    return body;
  }

  async probe(): Promise<boolean> {
    try {
      await this.status();
      return true;
    } catch {
      return false;
    }
  }

  private async requestStatus(action: Exclude<HermesControlAction, "cleanup-orphan-gateways">): Promise<HermesControlBridgeStatus> {
    const body = await this.request(action);
    if (!isStatus(body)) throw new Error("Hermes control bridge status response is invalid");
    return body;
  }

  private async request(action: HermesControlAction): Promise<unknown> {
    const token = readFileSync(this.tokenFile, "utf8").trim();
    if (token === "") throw new Error("Hermes control bridge token is missing");
    const response = await this.fetchImpl(`${this.baseUrl}/v1/control`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Treat malformed responses as unavailable below.
    }
    if (!response.ok) {
      throw new Error(`Hermes control bridge request failed (${response.status})`);
    }
    return body;
  }
}

function isStatus(value: unknown): value is HermesControlBridgeStatus {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.active === "boolean" && typeof record.unit === "string";
}

function isCleanupResult(value: unknown): value is HermesControlBridgeCleanupResult {
  if (!isStatus(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  return Array.isArray(record.cleanedPids) && record.cleanedPids.every((pid) => typeof pid === "number") &&
    (record.mainPid === null || typeof record.mainPid === "number");
}
