import { readFileSync } from "node:fs";
import {
  parseScheduledTaskRequest, parseScheduledTaskResponse, scheduledTaskFailure,
  SCHEDULED_TASK_MAX_RESPONSE,
  type ScheduledTaskRequest, type ScheduledTaskResponse,
} from "@butler/contract";
import type { HermesControlBridgeOptions } from "./control-bridge.js";

/** Host-only execution: the container never reads cron state or starts Hermes itself. */
export class HermesCronClient {
  constructor(private readonly options: HermesControlBridgeOptions) {}

  async request(input: ScheduledTaskRequest): Promise<ScheduledTaskResponse> {
    const request = parseScheduledTaskRequest(input);
    if (!request) throw new Error("invalid_scheduled_task_request");
    let token: string;
    try {
      token = readFileSync(this.options.tokenFile, "utf8").trim();
      if (!token) return scheduledTaskFailure(request, "token_unavailable");
    } catch { return scheduledTaskFailure(request, "token_unavailable"); }
    try {
      const response = await (this.options.fetchImpl ?? fetch)(
        `${this.options.baseUrl.replace(/\/+$/, "")}/v1/cron`,
        {
          method: "POST", redirect: "error",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 45_000),
        },
      );
      const body = await readScheduledTaskJson(response);
      const parsed = parseScheduledTaskResponse(request.action, body);
      if (!parsed || ("requestId" in request && (!("requestId" in parsed) || parsed.requestId !== request.requestId)) ||
        ("id" in request && "taskId" in parsed && parsed.taskId !== request.id)) {
        return scheduledTaskFailure(request, "invalid_response");
      }
      if (!response.ok && !parsed.reason) return scheduledTaskFailure(request, "invalid_response");
      return parsed;
    } catch {
      // A timeout is NOT permission to retry: the host journal owns the operation outcome.
      return scheduledTaskFailure(request, "bridge_unreachable");
    }
  }
}

export async function readScheduledTaskJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SCHEDULED_TASK_MAX_RESPONSE) {
        await reader.cancel();
        throw new Error("invalid_response");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}
