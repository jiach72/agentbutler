import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeHealth,
  type ChannelId,
  type DeliveryAck,
  type DeliveryRequest,
  type InboundDecision,
  type InboundHistoryView,
  type MessageDecision,
  type OutboxChangeBatch,
  type OutboxMessageView,
  type PolicyAck,
  type PolicySnapshot,
  type PrewarmAck,
} from "@butler/contract";

export interface HermesBridgeClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class BridgeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(`Hermes Bridge ${status} ${code}: ${detail}`);
    this.name = "BridgeHttpError";
  }
}

export class HermesBridgeClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HermesBridgeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async health(): Promise<BridgeHealth> {
    const health = await this.request<BridgeHealth>("GET", "/v1/health");
    if (health.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
      throw new BridgeHttpError(
        409,
        "protocol_mismatch",
        `expected ${BRIDGE_PROTOCOL_VERSION}, received ${String(health.protocolVersion)}`,
      );
    }
    return health;
  }

  installPolicy(snapshot: PolicySnapshot): Promise<PolicyAck> {
    return this.request("POST", "/v1/policy", snapshot);
  }

  listChanges(afterSequence: number, limit = 100): Promise<OutboxChangeBatch> {
    const query = new URLSearchParams({
      after: String(afterSequence),
      limit: String(limit),
    });
    return this.request("GET", `/v1/outbox/changes?${query.toString()}`);
  }

  decide(decision: MessageDecision): Promise<OutboxMessageView> {
    return this.request(
      "POST",
      `/v1/outbox/${encodeURIComponent(decision.messageId)}/decision`,
      decision,
    );
  }

  deliver(request: DeliveryRequest): Promise<DeliveryAck> {
    return this.request("POST", "/v1/deliver", request);
  }

  forwardInbound(decision: InboundDecision): Promise<InboundDecision> {
    return this.request(
      "POST",
      `/v1/inbound/${encodeURIComponent(decision.inboundMessageId)}/decision`,
      decision,
    );
  }

  prewarm(channel: ChannelId): Promise<PrewarmAck> {
    return this.request("POST", "/v1/prewarm", { channel });
  }

  inboundHistory(limit = 50): Promise<InboundHistoryView> {
    const query = new URLSearchParams({ limit: String(limit) });
    return this.request("GET", `/v1/inbound/history?${query.toString()}`);
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "x-butler-bridge-version": String(BRIDGE_PROTOCOL_VERSION),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new BridgeHttpError(0, "transport_error", errorMessage(error));
    }

    const text = await response.text();
    const parsed = parseJson(text);
    if (!response.ok) {
      const errorBody = isRecord(parsed) ? parsed : {};
      throw new BridgeHttpError(
        response.status,
        readString(errorBody["error"]) ?? "http_error",
        (readString(errorBody["detail"]) ?? text ?? response.statusText).slice(0, 2_048),
      );
    }
    return parsed as T;
  }
}

function parseJson(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BridgeHttpError(502, "invalid_json", text.slice(0, 2_048));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
