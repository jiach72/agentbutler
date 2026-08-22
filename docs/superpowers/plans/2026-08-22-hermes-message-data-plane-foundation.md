# Hermes Message Data Plane Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the versioned messaging contract, WSL-local SQLite Outbox, strict Hermes adapter wrapper, authenticated Bridge HTTP service, and TypeScript Bridge client that later policy and UI phases can rely on.

**Architecture:** Hermes captures outbound messages inside the adapter instance before native delivery, persists them to `/home/jiach/.hermes/agent-butler/outbox.sqlite`, and exposes a localhost Bridge API. Butler talks to that API through a typed client; queued push messages never fall back to native delivery, while inline request/response messages are persisted before the original responder is invoked.

**Tech Stack:** TypeScript 5.9, Node.js 22 `fetch`, Vitest 3, Python 3.11 stdlib `sqlite3`, `aiohttp`, `unittest`, WSL2 Ubuntu-24.04.

## Global Constraints

- Preserve all existing untracked project files; stage and commit only files belonging to the current task.
- The authoritative Outbox path is `/home/jiach/.hermes/agent-butler/outbox.sqlite`, on the WSL Linux filesystem rather than `/mnt/c`.
- `queued-push` messages never use passthrough when Butler is offline.
- `inline-response` messages are persisted first and use the last valid Bridge policy snapshot; invalid/missing policy returns a retryable protocol error.
- `messageId` is UUIDv7 and remains stable across retries and restarts.
- `delivery_unknown` never retries automatically.
- Urgent/failure policy bypass and AIMD are implemented in the next policy plan; this foundation must preserve the required priority, kind, run, and transport fields.
- API Server and A2A inline responses receive no artificial 30-second delay.
- Weixin native endpoint protection remains authoritative; this phase does not remove or weaken its current `30 / 30 / 1 / 2000` settings.
- Real Hermes writes require a snapshot and use `hermes-gateway.service`; this foundation phase does not patch or restart the real service.
- Bridge APIs listen on localhost and require a bearer token sourced from a mode-`0600` file.

---

### Task 1: Replace the placeholder messaging contract with Bridge v1 types

**Files:**
- Modify: `packages/contract/src/messaging.ts`
- Create: `packages/contract/tests/messaging.test.ts`

**Interfaces:**
- Consumes: `ChannelId`, `InstanceId`, `InstanceRef`, `Result` from `packages/contract/src/common.ts`.
- Produces: `OutboundEnvelope`, `InboundEnvelope`, `TaskEvent`, `BridgeHealth`, `MessageDecision`, `DeliveryRequest`, `DeliveryAck`, `OutboxChangeBatch`, and the revised `MessagingAdapter` interface.

- [ ] **Step 1: Write the failing runtime-constant tests**

```ts
import { describe, expect, it } from "vitest";
import {
  BRIDGE_PROTOCOL_VERSION,
  MESSAGE_KINDS,
  OUTBOX_STATES,
  TASK_EVENT_KINDS,
  TRANSPORT_CLASSES,
  isOutboxState,
} from "../src/messaging.js";

describe("messaging contract v1", () => {
  it("exports stable Bridge protocol literals", () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(1);
    expect(TRANSPORT_CLASSES).toEqual(["queued-push", "inline-response"]);
    expect(MESSAGE_KINDS).toContain("final");
    expect(MESSAGE_KINDS).toContain("failure");
    expect(TASK_EVENT_KINDS).toEqual(["started", "progress", "completing", "done", "failed"]);
  });

  it("recognizes every durable state and rejects unknown values", () => {
    for (const state of OUTBOX_STATES) expect(isOutboxState(state)).toBe(true);
    expect(isOutboxState("pending")).toBe(false);
    expect(isOutboxState(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `pnpm --filter @butler/contract exec vitest run tests/messaging.test.ts`

Expected: FAIL because the Bridge v1 constants are not exported.

- [ ] **Step 3: Implement the complete Bridge v1 contract**

Replace `packages/contract/src/messaging.ts` with types using these exact literals and fields:

```ts
import type { ChannelId, InstanceId, InstanceRef, Result } from "./common.js";

export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export const TRANSPORT_CLASSES = ["queued-push", "inline-response"] as const;
export const MESSAGE_KINDS = [
  "final",
  "task-progress",
  "failure",
  "alert",
  "system",
  "mutation",
] as const;
export const OUTBOX_STATES = [
  "captured",
  "policy_pending",
  "held_dnd",
  "held_pacing",
  "ready",
  "delivering",
  "retry_wait",
  "delivered",
  "delivery_unknown",
  "absorbed",
  "policy_error",
  "dead_letter",
  "cancelled",
] as const;
export const TASK_EVENT_KINDS = ["started", "progress", "completing", "done", "failed"] as const;

export type TransportClass = (typeof TRANSPORT_CLASSES)[number];
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type OutboxState = (typeof OUTBOX_STATES)[number];
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];
export type MessagePriority = "urgent" | "normal" | "low";
export type Unsubscribe = () => void;

export interface OutboundEnvelope {
  messageId: string;
  instanceId: InstanceId;
  adapterId: string;
  channel: ChannelId;
  accountId?: string;
  chatId: string;
  threadId?: string;
  sessionId: string;
  runId?: string;
  inboundMessageId?: string;
  messageKind: MessageKind;
  transport: TransportClass;
  priority: MessagePriority;
  content: string;
  contentSha256: string;
  replyTo?: string;
  metadata: Record<string, unknown>;
  capturedAt: string;
}

export interface InboundEnvelope {
  inboundMessageId: string;
  instanceId: InstanceId;
  adapterId: string;
  channel: ChannelId;
  chatId: string;
  threadId?: string;
  userId?: string;
  sessionId?: string;
  runId?: string;
  content: string;
  receivedAt: string;
}

export interface TaskEvent {
  runId: string;
  sequence: number;
  sessionId: string;
  kind: TaskEventKind;
  summary?: string;
  etaSec?: number;
  occurredAt: string;
}

export interface BridgeHealth {
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  bridgeVersion: string;
  instanceId: InstanceId;
  attached: boolean;
  outboxWritable: boolean;
  policyVersion: string | null;
  channels: Record<ChannelId, "ok" | "degraded" | "unavailable">;
}

export interface AttachAck {
  instanceId: InstanceId;
  attachedAt: string;
  channels: ChannelId[];
  bridgeVersion: string;
}

export interface OutboxMessageView extends OutboundEnvelope {
  sequence: number;
  state: OutboxState;
  availableAt: string | null;
  attemptCount: number;
  providerMessageId: string | null;
  deliveredAt: string | null;
  lastError: string | null;
  transformTrace: string[];
}

export interface OutboxChangeBatch {
  afterSequence: number;
  nextSequence: number;
  items: OutboxMessageView[];
  taskEvents: TaskEvent[];
  inbound: InboundEnvelope[];
}

export interface MessageDecision {
  messageId: string;
  expectedContentSha256: string;
  state: Extract<OutboxState, "held_dnd" | "held_pacing" | "ready" | "absorbed" | "policy_error" | "cancelled">;
  availableAt?: string;
  optimizedContent?: string;
  transformTrace: string[];
  policyVersion: string;
  reason: string;
}

export interface DeliveryRequest {
  messageId: string;
  attemptId: string;
  expectedContentSha256: string;
}

export interface DeliveryAck {
  messageId: string;
  attemptId: string;
  accepted: boolean;
  deduped: boolean;
  state: Extract<OutboxState, "delivered" | "retry_wait" | "delivery_unknown" | "dead_letter">;
  providerMessageId: string | null;
  finishedAt: string;
  error?: string;
}

export interface InboundDecision {
  inboundMessageId: string;
  action: "forward" | "consume-command";
  optimizedText: string;
  transformTrace: string[];
}

export interface PrewarmAck {
  channel: ChannelId;
  warmed: boolean;
  checkedAt: string;
  expiresAt: string | null;
  detail?: string;
}

export interface MessagingAdapter {
  attachOutbound(instance: InstanceRef): Promise<Result<AttachAck>>;
  health(instance: InstanceRef): Promise<Result<BridgeHealth>>;
  listChanges(instance: InstanceRef, afterSequence: number, limit?: number): Promise<Result<OutboxChangeBatch>>;
  decideOutbound(instance: InstanceRef, decision: MessageDecision): Promise<Result<OutboxMessageView>>;
  deliver(instance: InstanceRef, request: DeliveryRequest): Promise<Result<DeliveryAck>>;
  forwardInbound(instance: InstanceRef, decision: InboundDecision): Promise<Result<InboundDecision>>;
  subscribeTaskEvents(instance: InstanceRef, cb: (event: TaskEvent) => void): Unsubscribe;
  prewarmChannel(instance: InstanceRef, channel: ChannelId): Promise<Result<PrewarmAck>>;
}

export function isOutboxState(value: unknown): value is OutboxState {
  return typeof value === "string" && (OUTBOX_STATES as readonly string[]).includes(value);
}
```

- [ ] **Step 4: Run contract tests and type-check**

Run: `pnpm --filter @butler/contract exec vitest run tests/messaging.test.ts`

Expected: PASS, 2 tests.

Run: `pnpm --filter @butler/contract exec tsc -p tsconfig.json --noEmit`

Expected: exit 0.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- packages/contract/src/messaging.ts packages/contract/tests/messaging.test.ts
git -c user.name="Codex" -c user.email="codex@local.invalid" commit -m "feat(contract): define Hermes Bridge messaging v1"
```

---

### Task 2: Implement UUIDv7 and the durable Python Outbox

**Files:**
- Create: `packages/adapters/hermes/bridge/agent_butler_bridge/__init__.py`
- Create: `packages/adapters/hermes/bridge/agent_butler_bridge/ids.py`
- Create: `packages/adapters/hermes/bridge/agent_butler_bridge/outbox.py`
- Create: `packages/adapters/hermes/bridge/tests/test_outbox.py`

**Interfaces:**
- Consumes: JSON-safe envelope dictionaries matching `OutboundEnvelope`.
- Produces: `uuid7() -> str` and `Outbox` methods `capture`, `get`, `list_changes`, `apply_decision`, `begin_delivery`, `finish_delivery`, `mark_retry`, `mark_unknown`, `record_task_event`, `record_inbound`, `set_policy_snapshot`, and `get_policy_snapshot`.

- [ ] **Step 1: Write UUID and restart/idempotency tests**

```py
import tempfile
import unittest
import uuid
from pathlib import Path

from agent_butler_bridge.ids import uuid7
from agent_butler_bridge.outbox import Outbox


class OutboxTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "outbox.sqlite"
        self.outbox = Outbox(self.db_path)

    def tearDown(self):
        self.outbox.close()
        self.tmp.cleanup()

    def test_uuid7_has_version_7_and_sorts_by_time(self):
        first = uuid7(now_ms=1_700_000_000_000, random_bytes=b"\x00" * 10)
        second = uuid7(now_ms=1_700_000_000_001, random_bytes=b"\x00" * 10)
        self.assertEqual(uuid.UUID(first).version, 7)
        self.assertLess(first, second)

    def test_capture_is_idempotent_across_reopen(self):
        envelope = make_envelope("018bcfe5-6800-7000-8000-000000000001")
        first = self.outbox.capture(envelope)
        duplicate = self.outbox.capture(envelope)
        self.assertFalse(first["deduped"])
        self.assertTrue(duplicate["deduped"])
        self.outbox.close()
        self.outbox = Outbox(self.db_path)
        self.assertEqual(self.outbox.get(envelope["messageId"])["state"], "captured")

    def test_delivery_unknown_is_not_claimable_after_restart(self):
        envelope = make_envelope("018bcfe5-6800-7000-8000-000000000002")
        self.outbox.capture(envelope)
        self.outbox.apply_decision(envelope["messageId"], envelope["contentSha256"], "ready", None, [], "p1", "ready")
        self.outbox.begin_delivery(envelope["messageId"], "attempt-1", envelope["contentSha256"])
        self.outbox.mark_unknown(envelope["messageId"], "attempt-1", "process exited after send")
        self.outbox.close()
        self.outbox = Outbox(self.db_path)
        self.assertIsNone(self.outbox.next_ready("2100-01-01T00:00:00.000Z"))

    def test_policy_snapshot_survives_reopen(self):
        self.outbox.set_policy_snapshot("policy-1", "sha256-value", {"inlineResponse": "allow"})
        self.outbox.close()
        self.outbox = Outbox(self.db_path)
        self.assertEqual(
            self.outbox.get_policy_snapshot(),
            {"version": "policy-1", "sha256": "sha256-value", "payload": {"inlineResponse": "allow"}},
        )
```

`make_envelope()` must return every required field, use `contentSha256` for `"hello"`, and set transport `queued-push`.

- [ ] **Step 2: Run the Python test and confirm imports fail**

Run from WSL repository root:

```bash
PYTHONPATH=packages/adapters/hermes/bridge python3 -m unittest packages/adapters/hermes/bridge/tests/test_outbox.py -v
```

Expected: FAIL because `agent_butler_bridge` does not exist.

- [ ] **Step 3: Implement RFC-compatible UUIDv7 generation**

```py
def uuid7(*, now_ms: int | None = None, random_bytes: bytes | None = None) -> str:
    timestamp = int(time.time_ns() // 1_000_000 if now_ms is None else now_ms)
    if timestamp < 0 or timestamp >= 1 << 48:
        raise ValueError("now_ms must fit in 48 bits")
    entropy = os.urandom(10) if random_bytes is None else random_bytes
    if len(entropy) != 10:
        raise ValueError("random_bytes must contain exactly 10 bytes")
    random_value = int.from_bytes(entropy, "big")
    rand_a = (random_value >> 68) & 0xFFF
    rand_b = random_value & ((1 << 62) - 1)
    value = (timestamp << 80) | (0x7 << 76) | (rand_a << 64) | (0b10 << 62) | rand_b
    return str(uuid.UUID(int=value))
```

- [ ] **Step 4: Implement the SQLite schema and state transitions**

`Outbox.__init__` must create the parent directory, set `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`, `PRAGMA busy_timeout=5000`, and create these tables:

```sql
CREATE TABLE outbound_messages (
  message_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE,
  instance_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  account_id TEXT,
  chat_id TEXT NOT NULL,
  thread_id TEXT,
  session_id TEXT NOT NULL,
  run_id TEXT,
  inbound_message_id TEXT,
  message_kind TEXT NOT NULL,
  transport TEXT NOT NULL,
  priority TEXT NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  reply_to TEXT,
  metadata_json TEXT NOT NULL,
  state TEXT NOT NULL,
  available_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  active_attempt_id TEXT,
  provider_message_id TEXT,
  policy_version TEXT,
  transform_trace_json TEXT NOT NULL DEFAULT '[]',
  last_error TEXT,
  captured_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE TABLE delivery_attempts (
  attempt_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES outbound_messages(message_id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT,
  error TEXT
);
CREATE TABLE task_events (
  run_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT,
  eta_sec INTEGER,
  occurred_at TEXT NOT NULL,
  change_sequence INTEGER NOT NULL UNIQUE,
  PRIMARY KEY (run_id, event_sequence)
);
CREATE TABLE inbound_messages (
  inbound_message_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  change_sequence INTEGER NOT NULL UNIQUE,
  received_at TEXT NOT NULL
);
CREATE TABLE bridge_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

Use `BEGIN IMMEDIATE` for capture and delivery transitions. `capture()` inserts once and returns the existing row on duplicate. Constructor recovery changes stale `delivering` rows to `delivery_unknown`, never to ready. `set_policy_snapshot()` stores version, hash, and canonical JSON payload in one transaction; `get_policy_snapshot()` returns `None` unless all three fields are present and valid.

- [ ] **Step 5: Run the Outbox tests**

Run: `wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && PYTHONPATH=packages/adapters/hermes/bridge python3 -m unittest packages/adapters/hermes/bridge/tests/test_outbox.py -v"`

Expected: PASS, including reopen and unknown-delivery assertions.

- [ ] **Step 6: Commit Task 2**

```powershell
git add -- packages/adapters/hermes/bridge/agent_butler_bridge packages/adapters/hermes/bridge/tests/test_outbox.py
git -c user.name="Codex" -c user.email="codex@local.invalid" commit -m "feat(hermes): add durable Bridge outbox"
```

---

### Task 3: Add the native method registry and strict adapter wrapper

**Files:**
- Create: `packages/adapters/hermes/bridge/agent_butler_bridge/registry.py`
- Create: `packages/adapters/hermes/bridge/agent_butler_bridge/wrapper.py`
- Create: `packages/adapters/hermes/bridge/tests/test_wrapper.py`

**Interfaces:**
- Consumes: `Outbox.capture()` and Hermes-compatible adapter objects with `send()` and optional `edit_message()`.
- Produces: `NativeRegistry.attach(adapter, context)`, `NativeRegistry.deliver(message_id, attempt_id, expected_hash)`, and `attach_adapter()`.

- [ ] **Step 1: Write strict queued and inline wrapper tests**

```py
class FakeAdapter:
    def __init__(self):
        self.native_calls = []

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        self.native_calls.append((chat_id, content, reply_to, metadata))
        return FakeSendResult(success=True, message_id="provider-1")


class WrapperTest(unittest.IsolatedAsyncioTestCase):
    async def test_queued_push_persists_without_native_send(self):
        attach_adapter(self.adapter, self.registry, adapter_id="weixin", channel="weixin")
        result = await self.adapter.send("chat-1", "hello", metadata={"butler_session_id": "s1"})
        self.assertTrue(result.success)
        self.assertTrue(result.message_id.startswith("butler:"))
        self.assertEqual(self.adapter.native_calls, [])
        row = self.outbox.list_changes(0, 10)["items"][0]
        self.assertEqual(row["transport"], "queued-push")

    async def test_inline_response_persists_then_calls_native(self):
        self.outbox.set_policy_snapshot("policy-1", "sha256-value", {"inlineResponse": "allow"})
        attach_adapter(self.adapter, self.registry, adapter_id="a2a", channel="a2a")
        result = await self.adapter.send("ctx-1", "answer", metadata={"butler_transport": "inline-response", "butler_session_id": "s1"})
        self.assertEqual(result.message_id, "provider-1")
        self.assertEqual(len(self.adapter.native_calls), 1)
        self.assertEqual(self.outbox.list_changes(0, 10)["items"][0]["state"], "delivered")

    async def test_attach_is_idempotent(self):
        first = attach_adapter(self.adapter, self.registry, adapter_id="weixin", channel="weixin")
        second = attach_adapter(self.adapter, self.registry, adapter_id="weixin", channel="weixin")
        self.assertIs(first, second)

    async def test_inline_response_fails_closed_without_policy_snapshot(self):
        attach_adapter(self.adapter, self.registry, adapter_id="a2a", channel="a2a")
        result = await self.adapter.send("ctx-1", "answer", metadata={"butler_transport": "inline-response", "butler_session_id": "s1"})
        self.assertFalse(result.success)
        self.assertIn("policy snapshot", result.error)
        self.assertEqual(self.adapter.native_calls, [])
```

- [ ] **Step 2: Run the wrapper test and confirm it fails**

Run: `wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && PYTHONPATH=packages/adapters/hermes/bridge python3 -m unittest packages/adapters/hermes/bridge/tests/test_wrapper.py -v"`

Expected: FAIL because `registry.py` and `wrapper.py` do not exist.

- [ ] **Step 3: Implement the registry and wrapper**

Use a `weakref.WeakKeyDictionary` keyed by adapter instance and a second lookup keyed by `adapter_id`. Store the original bound `send` and optional `edit_message`. The wrapper must:

```py
async def managed_send(chat_id, content, reply_to=None, metadata=None):
    safe_metadata = json_safe_metadata(metadata or {})
    transport = safe_metadata.pop("butler_transport", default_transport)
    envelope = build_envelope(
        adapter_id=adapter_id,
        channel=channel,
        chat_id=str(chat_id),
        content=str(content),
        reply_to=reply_to,
        metadata=safe_metadata,
        transport=transport,
    )
    capture = outbox.capture(envelope)
    if transport == "inline-response":
        policy = outbox.get_policy_snapshot()
        if policy is None or policy["payload"].get("inlineResponse") != "allow":
            return SendResult(success=False, error="Agent Butler policy snapshot unavailable")
        outbox.begin_delivery(envelope["messageId"], f"inline:{envelope['messageId']}", envelope["contentSha256"])
        try:
            result = await original_send(chat_id, content, reply_to=reply_to, metadata=metadata)
        except BaseException as exc:
            outbox.mark_unknown(envelope["messageId"], f"inline:{envelope['messageId']}", str(exc))
            raise
        if result.success:
            outbox.finish_delivery(envelope["messageId"], f"inline:{envelope['messageId']}", result.message_id)
        else:
            outbox.mark_retry(envelope["messageId"], f"inline:{envelope['messageId']}", result.error or "native send failed")
        return result
    return SendResult(success=True, message_id=f"butler:{envelope['messageId']}")
```

`NativeRegistry.deliver()` validates message existence, `ready` state, content hash, and attempt id before calling the saved original method. A duplicate call for `delivered` returns a deduped acknowledgement without calling native send. Unsupported metadata types are converted to strings only after removing keys containing `token`, `secret`, `password`, or `authorization`.

- [ ] **Step 4: Run wrapper and Outbox tests together**

Run: `wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && PYTHONPATH=packages/adapters/hermes/bridge python3 -m unittest discover -s packages/adapters/hermes/bridge/tests -v"`

Expected: PASS, no native call for queued push and exactly one native call for inline response.

- [ ] **Step 5: Commit Task 3**

```powershell
git add -- packages/adapters/hermes/bridge/agent_butler_bridge/registry.py packages/adapters/hermes/bridge/agent_butler_bridge/wrapper.py packages/adapters/hermes/bridge/tests/test_wrapper.py
git -c user.name="Codex" -c user.email="codex@local.invalid" commit -m "feat(hermes): capture adapter sends through Bridge"
```

---

### Task 4: Expose the authenticated Bridge HTTP API

**Files:**
- Create: `packages/adapters/hermes/bridge/agent_butler_bridge/auth.py`
- Create: `packages/adapters/hermes/bridge/agent_butler_bridge/server.py`
- Create: `packages/adapters/hermes/bridge/tests/test_server.py`

**Interfaces:**
- Consumes: `Outbox`, `NativeRegistry`, bearer token, instance id.
- Produces: `create_app(outbox, registry, token, instance_id) -> aiohttp.web.Application` with `/v1/health`, `/v1/outbox/changes`, `/v1/outbox/{messageId}/decision`, and `/v1/deliver`.

- [ ] **Step 1: Write authenticated route tests**

```py
class ServerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.app = create_app(self.outbox, self.registry, token="test-token", instance_id="hermes-main")
        self.server = TestServer(self.app)
        self.client = TestClient(self.server)
        await self.client.start_server()

    async def test_health_requires_auth_and_reports_protocol(self):
        denied = await self.client.get("/v1/health")
        self.assertEqual(denied.status, 401)
        ok = await self.client.get("/v1/health", headers={"Authorization": "Bearer test-token"})
        self.assertEqual(ok.status, 200)
        body = await ok.json()
        self.assertEqual(body["protocolVersion"], 1)
        self.assertTrue(body["outboxWritable"])

    async def test_decision_rejects_hash_mismatch(self):
        response = await self.client.post(
            f"/v1/outbox/{message_id}/decision",
            headers={"Authorization": "Bearer test-token"},
            json={"messageId": message_id, "expectedContentSha256": "wrong", "state": "ready", "transformTrace": [], "policyVersion": "p1", "reason": "test"},
        )
        self.assertEqual(response.status, 409)
```

- [ ] **Step 2: Run server tests and confirm they fail**

Run: `wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && PYTHONPATH=packages/adapters/hermes/bridge python3 -m unittest packages/adapters/hermes/bridge/tests/test_server.py -v"`

Expected: FAIL because `server.py` is missing.

- [ ] **Step 3: Implement auth and routes**

Use `hmac.compare_digest` for bearer tokens, reject request bodies above 1 MiB, return `X-Butler-Bridge-Version: 1`, and map errors consistently:

```py
HTTP_STATUS = {
    "unauthorized": 401,
    "not_found": 404,
    "invalid": 400,
    "conflict": 409,
    "unavailable": 503,
}
```

`GET /v1/outbox/changes` clamps `limit` to `1..200`. `POST /v1/deliver` accepts only `messageId`, `attemptId`, and `expectedContentSha256`; the message body is always loaded from Outbox. Never accept arbitrary content in the delivery request.

- [ ] **Step 4: Run all Python Bridge tests**

Run: `wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && PYTHONPATH=packages/adapters/hermes/bridge python3 -m unittest discover -s packages/adapters/hermes/bridge/tests -v"`

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```powershell
git add -- packages/adapters/hermes/bridge/agent_butler_bridge/auth.py packages/adapters/hermes/bridge/agent_butler_bridge/server.py packages/adapters/hermes/bridge/tests/test_server.py
git -c user.name="Codex" -c user.email="codex@local.invalid" commit -m "feat(hermes): expose authenticated Bridge API"
```

---

### Task 5: Implement the TypeScript Hermes Bridge client and MessagingAdapter

**Files:**
- Create: `packages/adapters/hermes/src/messaging/bridge-client.ts`
- Create: `packages/adapters/hermes/src/messaging/adapter.ts`
- Create: `packages/adapters/hermes/src/messaging/index.ts`
- Create: `packages/adapters/hermes/tests/messaging.test.ts`
- Modify: `packages/adapters/hermes/src/index.ts`

**Interfaces:**
- Consumes: Bridge v1 HTTP endpoints and the Task 1 contract types.
- Produces: `HermesBridgeClient`, `createHermesMessaging(options)`, and optional `messaging` on `createHermesAdapter(options)`.

- [ ] **Step 1: Write client mapping and authentication tests**

```ts
it("health maps Bridge v1 JSON and sends bearer auth", async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(HEALTH), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new HermesBridgeClient({ baseUrl: "http://127.0.0.1:8754", token: "secret", fetchImpl });
  await expect(client.health()).resolves.toEqual(HEALTH);
  expect(calls[0]!.headers.get("authorization")).toBe("Bearer secret");
});

it("MessagingAdapter converts unreachable Bridge to E302", async () => {
  const messaging = createHermesMessaging({
    baseUrl: "http://127.0.0.1:8754",
    token: "secret",
    fetchImpl: async () => { throw new Error("offline"); },
  });
  const result = await messaging.health({ instanceId: "hermes-main", rootPath: "/home/jiach/.hermes/hermes-agent" });
  expect(result.ok).toBe(false);
  expect(result.error?.code).toBe("E302");
});
```

- [ ] **Step 2: Run the Hermes messaging test and confirm it fails**

Run: `pnpm --filter @butler/adapter-hermes exec vitest run tests/messaging.test.ts`

Expected: FAIL because the client and adapter do not exist.

- [ ] **Step 3: Implement the HTTP client**

`HermesBridgeClient` receives `{ baseUrl, token, fetchImpl?, timeoutMs? }`. Its private request method uses `AbortSignal.timeout(timeoutMs ?? 5000)`, content type JSON, bearer auth, and `X-Butler-Bridge-Version: 1`. Non-2xx responses throw `BridgeHttpError(status, code, detail)` with the server response redacted to 2 KiB.

Methods and paths:

```ts
health(): Promise<BridgeHealth>                              // GET /v1/health
listChanges(afterSequence: number, limit = 100): Promise<OutboxChangeBatch>
decide(decision: MessageDecision): Promise<OutboxMessageView>
deliver(request: DeliveryRequest): Promise<DeliveryAck>
forwardInbound(decision: InboundDecision): Promise<InboundDecision>
prewarm(channel: ChannelId): Promise<PrewarmAck>
```

- [ ] **Step 4: Implement `createHermesMessaging` and adapter injection**

`createHermesMessaging()` wraps each client call with `ok()`/`fail()`. HTTP 401 maps to E303; transport failures and 5xx map to E302; invalid input maps to E002. `subscribeTaskEvents` starts an abortable polling loop using `listChanges`, emits unseen `(runId, sequence)` events, and returns a synchronous unsubscribe function.

Extend `HermesAdapterOptions` with:

```ts
export interface HermesMessagingOptions {
  bridgeUrl?: string;
  bridgeToken?: string;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
}

export type HermesAdapterOptions = HermesControlOptions & { messaging?: HermesMessagingOptions };
```

Only attach `bundle.messaging` when both `bridgeUrl` and `bridgeToken` are non-empty. Do not change the manifest or capability status in this task; L3 becomes visible only after real Bridge installation and coverage verification.

- [ ] **Step 5: Run adapter tests and type-check**

Run: `pnpm --filter @butler/adapter-hermes exec vitest run tests/messaging.test.ts tests/smoke.test.ts`

Expected: PASS; existing smoke continues to report manifest L2.

Run: `pnpm --filter @butler/adapter-hermes exec tsc -p tsconfig.json --noEmit`

Expected: exit 0.

- [ ] **Step 6: Commit Task 5**

```powershell
git add -- packages/adapters/hermes/src/messaging packages/adapters/hermes/src/index.ts packages/adapters/hermes/tests/messaging.test.ts
git -c user.name="Codex" -c user.email="codex@local.invalid" commit -m "feat(hermes): add Butler Bridge messaging client"
```

---

### Task 6: Verify the foundation as a single contract boundary

**Files:**
- Modify only if verification exposes a defect: files from Tasks 1-5.

**Interfaces:**
- Consumes: all foundation modules.
- Produces: a green, documented base for the policy, installation, and product plans.

- [ ] **Step 1: Run all Bridge Python tests**

Run: `wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && PYTHONPATH=packages/adapters/hermes/bridge python3 -m unittest discover -s packages/adapters/hermes/bridge/tests -v"`

Expected: PASS.

- [ ] **Step 2: Run affected TypeScript packages**

Run: `pnpm --filter @butler/contract test`

Run: `pnpm --filter @butler/adapter-hermes test`

Run: `pnpm --filter @butler/contract exec tsc -p tsconfig.json --noEmit`

Run: `pnpm --filter @butler/adapter-hermes exec tsc -p tsconfig.json --noEmit`

Expected: all exit 0.

- [ ] **Step 3: Run repository hygiene checks**

Run: `pnpm lint`

Run: `git diff --check`

Expected: exit 0.

- [ ] **Step 4: Confirm no real Hermes files changed**

Run:

```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/jiach/.hermes/hermes-agent && git status --short gateway/run.py gateway/platforms/base.py gateway/platforms/weixin.py gateway/platforms/api_server.py plugins/platforms/a2a/adapter.py"
```

Expected: no changes introduced by this foundation plan.

## Following Plans

After this plan is green, continue the same approved goal with these separately reviewable plans:

1. `docs/superpowers/plans/2026-08-22-hermes-message-policy-pipeline.md` — Butler reconciliation, aggregation, DND, AIMD, prewarm, and delivery loop.
2. `docs/superpowers/plans/2026-08-22-hermes-message-runtime-integration.md` — managed Hermes patch, task lifecycle, API/A2A response hooks, inbound correlation, installation, snapshot, and rollback.
3. `docs/superpowers/plans/2026-08-22-hermes-message-product-validation.md` — web proxy, PRD-style UI, real WSL fault injection, controlled channel validation, and M5 implementation method.
