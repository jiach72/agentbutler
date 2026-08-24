import {
  fail,
  ok,
  type AttachAck,
  type BridgeHealth,
  type InstanceRef,
  type MessagingAdapter,
  type Result,
  type TaskEvent,
  type Unsubscribe,
} from "@butler/contract";
import {
  BridgeHttpError,
  HermesBridgeClient,
  type HermesBridgeClientOptions,
} from "./bridge-client.js";

export interface HermesMessagingOptions extends HermesBridgeClientOptions {
  pollIntervalMs?: number;
}

export function createHermesMessaging(options: HermesMessagingOptions): MessagingAdapter {
  const client = new HermesBridgeClient(options);
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 1_000);

  return {
    attachOutbound: (instance) =>
      wrapCall(async () => {
        const health = await client.health();
        assertInstance(instance, health);
        if (!health.attached || !health.outboxWritable) {
          throw new BridgeHttpError(
            503,
            "bridge_not_attached",
            "Bridge has not attached Hermes adapters or Outbox is read-only",
          );
        }
        return {
          instanceId: health.instanceId,
          attachedAt: new Date().toISOString(),
          channels: Object.keys(health.channels),
          bridgeVersion: health.bridgeVersion,
        } satisfies AttachAck;
      }),
    health: (instance) =>
      wrapCall(async () => {
        const health = await client.health();
        assertInstance(instance, health);
        return health;
      }),
    updatePolicy: (_instance, snapshot) => wrapCall(() => client.installPolicy(snapshot)),
    listChanges: (_instance, afterSequence, limit) =>
      wrapCall(() => client.listChanges(afterSequence, limit)),
    decideOutbound: (_instance, decision) => wrapCall(() => client.decide(decision)),
    deliver: (_instance, request) => wrapCall(() => client.deliver(request)),
    forwardInbound: (_instance, decision) => wrapCall(() => client.forwardInbound(decision)),
    inboundHistory: (_instance, limit) => wrapCall(() => client.inboundHistory(limit)),
    subscribeTaskEvents: (_instance, cb) => subscribe(client, pollIntervalMs, cb),
    prewarmChannel: (_instance, channel) => wrapCall(() => client.prewarm(channel)),
  };
}

function subscribe(
  client: HermesBridgeClient,
  pollIntervalMs: number,
  cb: (event: TaskEvent) => void,
): Unsubscribe {
  let stopped = false;
  let cursor = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const poll = async (): Promise<void> => {
    if (stopped) return;
    try {
      const batch = await client.listChanges(cursor, 100);
      cursor = Math.max(cursor, batch.nextSequence);
      for (const event of batch.taskEvents) cb(event);
    } catch {
      // The next poll reconciles from the last committed cursor.
    } finally {
      if (!stopped) timer = setTimeout(() => void poll(), pollIntervalMs);
    }
  };

  void poll();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

async function wrapCall<T>(fn: () => Promise<T>): Promise<Result<T>> {
  const startedAt = Date.now();
  try {
    return ok(await fn(), startedAt);
  } catch (error) {
    if (error instanceof BridgeHttpError) {
      const code =
        error.status === 401 || error.status === 403
          ? "E303"
          : error.status === 0 || error.status >= 500
            ? "E302"
            : "E002";
      return fail(code, error.message, {
        startedAt,
        userHint:
          code === "E303"
            ? "Hermes Bridge 鉴权失败，请重新安装或轮换凭据"
            : code === "E302"
              ? "Hermes Bridge 不可达或尚未就绪"
              : "Hermes Bridge 拒绝了消息请求",
        cause: error,
      });
    }
    return fail("E302", errorMessage(error), {
      startedAt,
      userHint: "Hermes Bridge 调用失败",
      cause: error,
    });
  }
}

function assertInstance(instance: InstanceRef, health: BridgeHealth): void {
  if (instance.instanceId !== health.instanceId) {
    throw new BridgeHttpError(
      409,
      "instance_mismatch",
      `requested ${instance.instanceId}, Bridge serves ${health.instanceId}`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
