# Hermes Message Policy Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build Butler's durable Hermes reconciliation and policy worker so queued messages are deterministically aggregated, held by DND or AIMD, prewarmed, delivered once through Bridge, and projected for later UI/runtime integration.

**Architecture:** The WSL Bridge Outbox remains the delivery source of truth. Butler Gateway keeps a separate SQLite projection containing reconciliation cursors, task/message projections, DND rules, pacing lanes, and prewarm cache; it never replaces or directly edits the Bridge database. A polling reconciler durably ingests Bridge changes before advancing its cursor, applies an ordered pure policy pipeline, writes idempotent decisions back to Bridge, and runs due delivery attempts.

**Tech Stack:** TypeScript 5.9, Node.js 22 node:sqlite and node:crypto, Fastify 5, Vitest 3, Python 3.11 sqlite3/aiohttp, Hermes Bridge protocol v1.

## Global Constraints

- Preserve all existing untracked project files; stage and commit only files belonging to the current task.
- The WSL Outbox at /home/jiach/.hermes/agent-butler/outbox.sqlite remains authoritative for delivery state.
- Butler's projection database must not be presented as the Outbox and must never write the WSL SQLite file directly.
- queued-push never falls back to native delivery when Butler or the policy worker is unavailable.
- inline-response is outside the asynchronous DND/AIMD worker and continues to use the last valid Bridge policy snapshot.
- Every outbound policy decision is replay-safe through a deterministic decisionId; a lost HTTP response must not produce a hash-conflict dead end.
- delivery_unknown is never retried automatically.
- urgent priority and failure kind bypass DND; solicited replies bypass DND and asynchronous pacing.
- Weixin effective interval is max(AIMD interval, 30 seconds); the existing Hermes terminal protection remains authoritative.
- API Server and A2A inline-response receive no artificial 30-second delay.
- Message optimization is deterministic only: aggregation, dedupe, priority, length budgeting, formatting, and transform trace. No LLM rewriting is introduced.
- Prewarm actions are invisible to users and cached with a TTL.
- Task events are idempotent by (runId, sequence), and reconciliation is idempotent by Bridge change sequence.
- Real Hermes files are not modified or restarted by this plan.

---

### Task 1: Make outbound policy decisions replay-safe

**Files:**
- Modify: packages/contract/src/messaging.ts
- Modify: packages/contract/tests/messaging.test.ts
- Modify: packages/adapters/hermes/bridge/agent_butler_bridge/outbox.py
- Modify: packages/adapters/hermes/bridge/agent_butler_bridge/server.py
- Modify: packages/adapters/hermes/bridge/tests/test_outbox.py
- Modify: packages/adapters/hermes/bridge/tests/test_server.py
- Modify: packages/adapters/hermes/src/messaging/bridge-client.ts
- Modify: packages/adapters/hermes/tests/messaging.test.ts

**Interfaces:**
- Consumes: MessageDecision and Outbox.apply_decision from the foundation.
- Produces: MessageDecision.decisionId and replay semantics: the same decisionId returns the already-applied row even when expectedContentSha256 is the pre-transform hash.

- [ ] **Step 1: Write failing contract and Python replay tests**

~~~ts
it("requires a stable decision id", () => {
  const decision: MessageDecision = {
    decisionId: "decision:m1:p1:abc",
    messageId: "m1",
    expectedContentSha256: "before",
    state: "held_pacing",
    availableAt: "2026-08-22T10:00:30.000Z",
    optimizedContent: "digest",
    transformTrace: ["aggregate-progress"],
    policyVersion: "p1",
    reason: "paced",
  };
  expect(decision.decisionId).toBe("decision:m1:p1:abc");
});
~~~

~~~py
def test_same_decision_id_is_idempotent_after_content_transform(self):
    envelope = make_envelope("018bcfe5-6800-7000-8000-000000000101")
    self.outbox.capture(envelope)
    first = self.outbox.apply_decision(
        envelope["messageId"],
        "decision-1",
        envelope["contentSha256"],
        "held_pacing",
        "2026-08-22T10:00:30.000Z",
        ["aggregate-progress"],
        "p1",
        "paced",
        optimized_content="digest",
    )
    replay = self.outbox.apply_decision(
        envelope["messageId"],
        "decision-1",
        envelope["contentSha256"],
        "held_pacing",
        "2026-08-22T10:00:30.000Z",
        ["aggregate-progress"],
        "p1",
        "paced",
        optimized_content="digest",
    )
    self.assertEqual(replay["contentSha256"], first["contentSha256"])
~~~

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

~~~powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && PYTHONPATH=packages/adapters/hermes/bridge /home/jiach/.hermes/hermes-agent/venv/bin/python -m unittest packages/adapters/hermes/bridge/tests/test_outbox.py packages/adapters/hermes/bridge/tests/test_server.py -v"
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && corepack pnpm --filter @butler/contract exec vitest run tests/messaging.test.ts && corepack pnpm --filter @butler/adapter-hermes exec vitest run tests/messaging.test.ts"
~~~

Expected: FAIL because decisionId is not part of the protocol and Outbox does not persist it.

- [ ] **Step 3: Implement the migration and idempotent transition**

Add decision_id TEXT to outbound_messages. During Outbox startup, inspect PRAGMA table_info(outbound_messages) and run this migration when absent:

~~~sql
ALTER TABLE outbound_messages ADD COLUMN decision_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_decision_id
ON outbound_messages(decision_id)
WHERE decision_id IS NOT NULL;
~~~

Change the method signature to:

~~~py
def apply_decision(
    self,
    message_id: str,
    decision_id: str,
    expected_content_sha256: str,
    state: str,
    available_at: str | None,
    transform_trace: list[str],
    policy_version: str,
    reason: str,
    optimized_content: str | None = None,
) -> dict[str, Any]:
~~~

Inside the same BEGIN IMMEDIATE transaction:

1. Load message_id.
2. If row.decision_id equals decision_id, return the current row without mutation.
3. If decision_id exists on another message, raise ValueError("decision id conflict").
4. Validate expectedContentSha256 against the current row.
5. Apply the decision and persist decision_id atomically with state/content/hash/trace.

The HTTP route must require decisionId. The TypeScript contract becomes:

~~~ts
export interface MessageDecision {
  decisionId: string;
  messageId: string;
  expectedContentSha256: string;
  state: DecisionState;
  availableAt?: string;
  optimizedContent?: string;
  transformTrace: string[];
  policyVersion: string;
  reason: string;
}
~~~

- [ ] **Step 4: Re-run Bridge, contract, and adapter tests**

Run the two commands from Step 2.

Expected: all focused tests exit 0, including an HTTP replay using the same decisionId.

- [ ] **Step 5: Commit Task 1**

~~~powershell
git add -- packages/contract/src/messaging.ts packages/contract/tests/messaging.test.ts packages/adapters/hermes/bridge/agent_butler_bridge/outbox.py packages/adapters/hermes/bridge/agent_butler_bridge/server.py packages/adapters/hermes/bridge/tests/test_outbox.py packages/adapters/hermes/bridge/tests/test_server.py packages/adapters/hermes/src/messaging/bridge-client.ts packages/adapters/hermes/tests/messaging.test.ts
git -c user.name="Codex" -c user.email="codex@local.invalid" commit -m "fix(messaging): make Bridge decisions replay safe"
~~~

---

### Task 2: Define and hash the deterministic message policy

**Files:**
- Create: apps/gateway/src/message/types.ts
- Create: apps/gateway/src/message/config.ts
- Create: apps/gateway/tests/message-config.test.ts
- Modify: apps/gateway/src/index.ts

**Interfaces:**
- Consumes: PolicySnapshot and ChannelId from @butler/contract.
- Produces: MessagePolicyConfig, ChannelPolicy, DndRule, DEFAULT_MESSAGE_POLICY, validateMessagePolicy(), createPolicySnapshot().

- [ ] **Step 1: Write failing validation and canonical-hash tests**

~~~ts
it("keeps the Weixin terminal interval at or above 30 seconds", () => {
  expect(DEFAULT_MESSAGE_POLICY.channels.weixin.nativeMinIntervalSec).toBe(30);
  expect(() =>
    validateMessagePolicy({
      ...DEFAULT_MESSAGE_POLICY,
      channels: {
        ...DEFAULT_MESSAGE_POLICY.channels,
        weixin: {
          ...DEFAULT_MESSAGE_POLICY.channels.weixin,
          nativeMinIntervalSec: 29,
        },
      },
    }),
  ).toThrow(/30/);
});

it("creates the same hash for semantically identical key order", () => {
  const a = createPolicySnapshot(DEFAULT_MESSAGE_POLICY);
  const b = createPolicySnapshot(JSON.parse(JSON.stringify(DEFAULT_MESSAGE_POLICY)));
  expect(a.sha256).toBe(b.sha256);
  expect(a.payload.inlineResponse).toBe("allow");
});
~~~

- [ ] **Step 2: Run and confirm missing-module failure**

Run:

~~~powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && corepack pnpm --filter @butler/gateway exec vitest run tests/message-config.test.ts"
~~~

Expected: FAIL because apps/gateway/src/message/config.ts does not exist.

- [ ] **Step 3: Implement exact policy types and defaults**

~~~ts
export interface ChannelPolicy {
  minRatePerMin: number;
  initialRatePerMin: number;
  maxRatePerMin: number;
  additiveStep: number;
  multiplicativeFactor: number;
  successWindow: number;
  nativeMinIntervalSec: number;
  prewarmTtlSec: number;
}

export interface MessagePolicyConfig {
  version: string;
  inlineResponse: "allow";
  digest: {
    windowSec: number;
    maxItems: number;
    maxChars: number;
    finalAbsorbsPendingProgress: boolean;
  };
  delivery: {
    maxAttempts: number;
    retryBaseSec: number;
    retryMaxSec: number;
  };
  channels: Record<string, ChannelPolicy>;
}

export const DEFAULT_MESSAGE_POLICY: MessagePolicyConfig = {
  version: "message-policy-v1",
  inlineResponse: "allow",
  digest: {
    windowSec: 120,
    maxItems: 8,
    maxChars: 1800,
    finalAbsorbsPendingProgress: true,
  },
  delivery: {
    maxAttempts: 5,
    retryBaseSec: 15,
    retryMaxSec: 900,
  },
  channels: {
    weixin: {
      minRatePerMin: 1,
      initialRatePerMin: 2,
      maxRatePerMin: 2,
      additiveStep: 0.25,
      multiplicativeFactor: 0.5,
      successWindow: 4,
      nativeMinIntervalSec: 30,
      prewarmTtlSec: 300,
    },
    a2a: {
      minRatePerMin: 6,
      initialRatePerMin: 30,
      maxRatePerMin: 60,
      additiveStep: 2,
      multiplicativeFactor: 0.5,
      successWindow: 5,
      nativeMinIntervalSec: 0,
      prewarmTtlSec: 120,
    },
    "api-server": {
      minRatePerMin: 60,
      initialRatePerMin: 600,
      maxRatePerMin: 600,
      additiveStep: 10,
      multiplicativeFactor: 0.5,
      successWindow: 5,
      nativeMinIntervalSec: 0,
      prewarmTtlSec: 60,
    },
  },
};
~~~

validateMessagePolicy() rejects non-finite/negative values, rates outside min <= initial <= max, factors outside 0 < beta < 1, successWindow below 1, and Weixin nativeMinIntervalSec below 30.

createPolicySnapshot() recursively sorts object keys, hashes UTF-8 canonical JSON with SHA-256, and returns:

~~~ts
{
  version: config.version,
  sha256,
  payload: config,
}
~~~

- [ ] **Step 4: Run tests and type-check**

Run:

~~~powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && corepack pnpm --filter @butler/gateway exec vitest run tests/message-config.test.ts && corepack pnpm --filter @butler/gateway exec tsc -p tsconfig.json --noEmit"
~~~

Expected: exit 0.

- [ ] **Step 5: Commit Task 2**

~~~powershell
git add -- apps/gateway/src/message/types.ts apps/gateway/src/message/config.ts apps/gateway/tests/message-config.test.ts apps/gateway/src/index.ts
git -c user.name="Codex" -c user.email="codex@local.invalid" commit -m "feat(gateway): define deterministic message policy"
~~~

---

### Task 3: Add the durable Butler-side message projection

**Files:**
- Create: apps/gateway/src/message/store.ts
- Create: apps/gateway/tests/message-store.test.ts
- Modify: apps/gateway/src/index.ts

**Interfaces:**
- Consumes: OutboxChangeBatch, OutboxMessageView, TaskEvent, InboundEnvelope.
- Produces: MessagePolicyStore with ingestBatch(), cursor(), listPolicyCandidates(), updateRemoteView(row, decisionId?), savePolicy(), loadPolicy(), upsertDndRule(), resolveDndRules(), getPacingLane(), savePacingLane(), getPrewarm(), savePrewarm(), taskView(), messageView(), counts(), close().

- [ ] **Step 1: Write restart, dedupe, and due-query tests**

~~~ts
it("ingests a Bridge batch and advances cursor atomically", () => {
  const store = new MessagePolicyStore(dbFile);
  store.ingestBatch(BATCH);
  store.ingestBatch(BATCH);
  expect(store.cursor("hermes-main")).toBe(BATCH.nextSequence);
  expect(store.counts()).toMatchObject({ captured: 1 });
  expect(store.taskView("run-1")?.events).toHaveLength(2);
  store.close();

  const reopened = new MessagePolicyStore(dbFile);
  expect(reopened.cursor("hermes-main")).toBe(BATCH.nextSequence);
  expect(reopened.messageView("m1")?.messageId).toBe("m1");
  reopened.close();
});

it("returns locally scheduled held messages when their release time is due", () => {
  const store = new MessagePolicyStore(dbFile);
  store.ingestBatch(BATCH);
  store.updateRemoteView({
    ...BATCH.items[0],
    state: "held_pacing",
    availableAt: "2026-08-22T10:00:30.000Z",
  });
  expect(store.listPolicyCandidates("2026-08-22T10:00:29.999Z")).toEqual([]);
  expect(store.listPolicyCandidates("2026-08-22T10:00:30.000Z")[0]?.messageId).toBe("m1");
});
~~~

- [ ] **Step 2: Run and confirm missing-module failure**

Run:

~~~powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && corepack pnpm --filter @butler/gateway exec vitest run tests/message-store.test.ts"
~~~

Expected: FAIL because MessagePolicyStore does not exist.

- [ ] **Step 3: Implement the projection schema**

Use node:sqlite DatabaseSync, WAL, foreign_keys=ON, busy_timeout=5000, and BEGIN IMMEDIATE for ingestBatch. Create:

~~~sql
CREATE TABLE IF NOT EXISTS bridge_cursors (
  instance_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS message_projection (
  message_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  bridge_sequence INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL,
  available_at TEXT,
  content_sha256 TEXT NOT NULL,
  decision_id TEXT,
  last_policy_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_projection (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  last_event_sequence INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events_projection (
  run_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, event_sequence)
);
CREATE TABLE IF NOT EXISTS inbound_projection (
  inbound_message_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS message_policy (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dnd_rules (
  rule_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_key TEXT,
  time_zone TEXT NOT NULL,
  start_minute INTEGER,
  end_minute INTEGER,
  paused_until TEXT,
  enabled INTEGER NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pacing_lanes (
  lane_key TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  chat_id TEXT,
  rate_per_min REAL NOT NULL,
  success_count INTEGER NOT NULL,
  cooldown_until TEXT,
  last_sent_at TEXT,
  last_congestion_reason TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prewarm_cache (
  channel TEXT PRIMARY KEY,
  warmed INTEGER NOT NULL,
  checked_at TEXT NOT NULL,
  expires_at TEXT,
  detail TEXT
);
~~~

ingestBatch() must upsert messages and inbound rows, insert task events with INSERT OR IGNORE, rebuild each affected task projection in event-sequence order, and update bridge_cursors last in the same transaction. Reject a batch whose afterSequence does not equal the durable cursor, except an exact replay whose nextSequence is not greater.

listPolicyCandidates(now) returns, in Bridge sequence order, captured/policy_pending/ready rows plus held_dnd, held_pacing, and retry_wait rows whose local availableAt is due. It always excludes delivered, delivery_unknown, absorbed, policy_error, dead_letter, and cancelled rows.

savePolicy()/loadPolicy() persist the canonical validated policy and hash in the singleton row. updateRemoteView(row, decisionId?) stores the Bridge response and the decision id in one local transaction so a later worker cycle can replay the same decision after an uncertain HTTP response.

- [ ] **Step 4: Run store tests and type-check**

Run:

~~~powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && corepack pnpm --filter @butler/gateway exec vitest run tests/message-store.test.ts && corepack pnpm --filter @butler/gateway exec tsc -p tsconfig.json --noEmit"
~~~

Expected: exit 0.

- [ ] **Step 5: Commit Task 3**

~~~powershell
git add -- apps/gateway/src/message/store.ts apps/gateway/tests/message-store.test.ts apps/gateway/src/index.ts
git -c user.name="Codex" -c user.email="codex@local.invalid" commit -m "feat(gateway): persist Hermes message projections"
~~~

---

### Task 4: Implement aggregation, DND, and AIMD as pure policy functions

**Files:**
- Create: apps/gateway/src/message/digest.ts
- Create: apps/gateway/src/message/dnd.ts
- Create: apps/gateway/src/message/pacing.ts
- Create: apps/gateway/src/message/policy.ts
- Create: apps/gateway/tests/message-policy.test.ts
- Modify: apps/gateway/src/index.ts

**Interfaces:**
- Consumes: OutboxMessageView, TaskEvent[], DndRule[], MessagePolicyConfig, persisted pacing lanes.
- Produces: buildProgressDigest(), evaluateDnd(), evaluatePacing(), recordPacingSuccess(), recordPacingCongestion(), decideOutboundPolicy().

- [ ] **Step 1: Write failing ordered-policy tests**

~~~ts
it("failure bypasses DND and becomes ready when pacing permits", () => {
  const decision = decideOutboundPolicy({
    message: message({ messageKind: "failure", priority: "urgent" }),
    taskEvents: [],
    dndRules: [globalPause("2026-08-22T12:00:00.000Z")],
    channelLane: lane("weixin", null, 2),
    chatLane: lane("weixin", "chat-1", 2),
    now: "2026-08-22T10:00:00.000Z",
    config: DEFAULT_MESSAGE_POLICY,
  });
  expect(decision.state).toBe("ready");
  expect(decision.transformTrace).toContain("dnd:bypass-urgent");
});

it("session DND overrides channel and global rules", () => {
  const result = evaluateDnd({
    message: message({ channel: "weixin", chatId: "chat-1" }),
    rules: [
      fixedRule("global", null, false),
      fixedRule("channel", "weixin", false),
      fixedRule("session", "weixin:chat-1", true),
    ],
    now: "2026-08-22T10:00:00.000Z",
  });
  expect(result.held).toBe(true);
});

it("uses both channel and chat lanes and preserves the Weixin 30 second floor", () => {
  const result = evaluatePacing({
    message: message({ channel: "weixin", chatId: "chat-1" }),
    channelLane: { ...lane("weixin", null, 2), lastSentAt: "2026-08-22T10:00:00.000Z" },
    chatLane: { ...lane("weixin", "chat-1", 60), lastSentAt: null },
    policy: DEFAULT_MESSAGE_POLICY.channels.weixin,
    now: "2026-08-22T10:00:01.000Z",
  });
  expect(result.availableAt).toBe("2026-08-22T10:00:30.000Z");
});

it("absorbs pending task progress when the final reply arrives", () => {
  const result = buildProgressDigest({
    holder: message({ messageId: "progress-1", messageKind: "task-progress", runId: "run-1" }),
    incoming: message({ messageId: "final-1", messageKind: "final", runId: "run-1" }),
    events: progressEvents(),
    config: DEFAULT_MESSAGE_POLICY.digest,
  });
  expect(result.absorbHolder).toBe(true);
});
~~~

- [ ] **Step 2: Run and confirm missing-module failure**

Run:

~~~powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && corepack pnpm --filter @butler/gateway exec vitest run tests/message-policy.test.ts"
~~~

Expected: FAIL because the policy modules do not exist.

- [ ] **Step 3: Implement deterministic policy order**

decideOutboundPolicy() executes exactly:

1. Reject non queued-push candidates with policy_error.
2. Build/update one pending task-progress holder per instance/channel/chat/runId; absorb duplicate progress rows.
3. If final arrives for the run, return an additional absorb decision for the pending progress holder.
4. Apply DND: session key channel:chatId, then channel, then global. urgent/failure and metadata.solicitedReply=true bypass.
5. Apply pacing using both channel and chat lanes.
6. Return ready or held_pacing with a deterministic decisionId.

The decisionId is SHA-256 over canonical JSON containing messageId, expectedContentSha256, policy version, target state, availableAt, optimizedContent, and transformTrace.

buildProgressDigest() uses no LLM. It renders:

~~~text
任务 <run短ID>
已完成：<最多 4 项>
进行中：<最近一项>
失败：<失败项，没有则省略>
预计剩余：<eta，没有则省略>
~~~

It caps event items and UTF-16 code units using digest.maxItems and digest.maxChars, appending "…" when truncated.

recordPacingSuccess() increments successCount and, only when successWindow is reached, sets rate=min(rate+alpha,maxRate) and resets successCount.

recordPacingCongestion() sets rate=max(rate*beta,minRate), resets successCount, persists the reason, and sets cooldownUntil to max(Retry-After, one interval at the reduced rate).

- [ ] **Step 4: Run policy tests and type-check**

Run:

~~~powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && corepack pnpm --filter @butler/gateway exec vitest run tests/message-policy.test.ts && corepack pnpm --filter @butler/gateway exec tsc -p tsconfig.json --noEmit"
~~~

Expected: exit 0, including additive increase, multiplicative decrease, timezone-crossing DND, urgent bypass, and final-progress absorption.

- [ ] **Step 5: Commit Task 4**

~~~powershell
git add -- apps/gateway/src/message/digest.ts apps/gateway/src/message/dnd.ts apps/gateway/src/message/pacing.ts apps/gateway/src/message/policy.ts apps/gateway/tests/message-policy.test.ts apps/gateway/src/index.ts
git -c user.name="Codex" -c user.email="codex@local.invalid" commit -m "feat(gateway): add aggregation DND and AIMD policy"
~~~

---

### Task 5: Build reconciliation, prewarm, and delivery workers

**Files:**
- Create: apps/gateway/src/message/reconciler.ts
- Create: apps/gateway/src/message/service.ts
- Create: apps/gateway/tests/message-reconciler.test.ts
- Modify: apps/gateway/src/index.ts

**Interfaces:**
- Consumes: MessagingAdapter, InstanceRef, MessagePolicyStore, MessagePolicyConfig.
- Produces: MessageReconciler.reconcileOnce(), processDueOnce(), MessageGatewayService.start(), stop(), status(), updatePolicy().

- [ ] **Step 1: Write failing crash/replay and delivery tests**

~~~ts
it("persists a batch before making any remote policy decision", async () => {
  const messaging = fakeMessaging({ changes: BATCH, decideError: new Error("offline") });
  const reconciler = createReconciler(messaging);
  await expect(reconciler.reconcileOnce()).rejects.toThrow(/offline/);
  expect(store.cursor("hermes-main")).toBe(BATCH.nextSequence);
  expect(store.messageView("m1")?.state).toBe("captured");
});

it("replays the same decision id after an unknown response", async () => {
  const messaging = fakeMessaging({ loseFirstDecisionResponse: true });
  const reconciler = createReconciler(messaging);
  await expect(reconciler.processDueOnce()).rejects.toThrow();
  await reconciler.processDueOnce();
  expect(messaging.decisions[0]?.decisionId).toBe(messaging.decisions[1]?.decisionId);
});

it("prewarms once per TTL and then delivers a ready message", async () => {
  const messaging = fakeMessaging({ prewarmExpiresAt: "2026-08-22T10:05:00.000Z" });
  const reconciler = createReconciler(messaging);
  await reconciler.processDueOnce();
  await reconciler.processDueOnce();
  expect(messaging.prewarmCalls).toEqual(["weixin"]);
  expect(messaging.deliveryCalls).toHaveLength(1);
});

it("does not automatically retry delivery_unknown", async () => {
  const messaging = fakeMessaging({ deliveryState: "delivery_unknown" });
  const reconciler = createReconciler(messaging);
  await reconciler.processDueOnce();
  await reconciler.processDueOnce();
  expect(messaging.deliveryCalls).toHaveLength(1);
});
~~~

- [ ] **Step 2: Run and confirm missing-module failure**

Run:

~~~powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && corepack pnpm --filter @butler/gateway exec vitest run tests/message-reconciler.test.ts"
~~~

Expected: FAIL because reconciler.ts and service.ts do not exist.

- [ ] **Step 3: Implement reconciliation and due processing**

reconcileOnce():

~~~ts
const cursor = store.cursor(instance.instanceId);
const result = await messaging.listChanges(instance, cursor, 200);
if (!result.ok) throw result.error;
store.ingestBatch(result.data);
await processDueOnce();
~~~

processDueOnce() processes at most one candidate to avoid bursts:

1. Load a due local projection.
2. Recompute the policy from current durable config/rules/lanes/task events.
3. Apply any companion absorb decision before the main decision.
4. Call decideOutbound and persist the returned remote row.
5. If held_dnd, held_pacing, absorbed, policy_error, or cancelled, stop.
6. Check a non-expired successful prewarm cache. If absent, call prewarmChannel.
7. A normal message whose prewarm fails becomes held_pacing with a retry time. An urgent/failure message records the failed prewarm trace and still attempts one delivery.
8. Generate attemptId with crypto.randomUUID(), call deliver using the row's current contentSha256, and persist the acknowledgement.
9. On delivered, update both channel and chat lanes with success. On retry_wait, compute and persist a local availableAt from retryBaseSec/retryMaxSec; when the error contains 429/rate-limit/disconnect/circuit evidence, also apply multiplicative decrease and cooldown. When retry_wait becomes due, re-apply a replay-safe ready decision before delivery. On delivery_unknown, persist terminal-manual state locally and never select it again automatically.

MessageGatewayService uses an injected scheduler, prevents overlapping cycles, installs the current policy snapshot through updatePolicy before starting, runs immediately, then at a configurable interval defaulting to 1000 ms.

- [ ] **Step 4: Run worker tests, gateway tests, and type-check**

Run:

~~~powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && corepack pnpm --filter @butler/gateway test && corepack pnpm --filter @butler/gateway exec tsc -p tsconfig.json --noEmit"
~~~

Expected: exit 0.

- [ ] **Step 5: Commit Task 5**

~~~powershell
git add -- apps/gateway/src/message/reconciler.ts apps/gateway/src/message/service.ts apps/gateway/tests/message-reconciler.test.ts apps/gateway/src/index.ts
git -c user.name="Codex" -c user.email="codex@local.invalid" commit -m "feat(gateway): reconcile and deliver Hermes messages"
~~~

---

### Task 6: Expose message status and policy controls through Gateway

**Files:**
- Modify: apps/gateway/src/server.ts
- Modify: apps/gateway/src/main.ts
- Modify: apps/gateway/tests/http.test.ts
- Create: apps/gateway/tests/message-http.test.ts
- Modify: apps/gateway/src/index.ts

**Interfaces:**
- Consumes: MessageGatewayService and MessagePolicyStore.
- Produces: local-only Gateway routes for status, messages, tasks, DND, policy, and internal reconciliation hints.

- [ ] **Step 1: Write failing HTTP tests**

~~~ts
it("reports real projected message state", async () => {
  const res = await app.inject({ method: "GET", url: "/api/messages/status" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({
    bridge: { connected: true, policyVersion: "message-policy-v1" },
    counts: { held_dnd: 1, delivery_unknown: 0 },
  });
});

it("upserts a scoped DND rule with an IANA timezone", async () => {
  const res = await app.inject({
    method: "PUT",
    url: "/api/messages/dnd/session/weixin%3Achat-1",
    payload: {
      timeZone: "Asia/Shanghai",
      startMinute: 1320,
      endMinute: 420,
      enabled: true,
    },
  });
  expect(res.statusCode).toBe(200);
});

it("dedupes internal Hermes hints and still relies on reconciliation", async () => {
  const first = await app.inject({
    method: "POST",
    url: "/internal/hermes/outbound",
    payload: { messageId: "m1" },
  });
  const second = await app.inject({
    method: "POST",
    url: "/internal/hermes/outbound",
    payload: { messageId: "m1" },
  });
  expect(first.json()).toEqual({ accepted: true, deduped: false });
  expect(second.json()).toEqual({ accepted: true, deduped: true });
});
~~~

- [ ] **Step 2: Run and confirm route failures**

Run:

~~~powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && corepack pnpm --filter @butler/gateway exec vitest run tests/message-http.test.ts"
~~~

Expected: FAIL with 404 routes.

- [ ] **Step 3: Add injected message service and local APIs**

Extend GatewayServerOptions with optional messageService and messageStore. Do not create a real Hermes client from environment in this task; runtime wiring belongs to the runtime-integration plan.

Add:

- GET /api/messages/status
- GET /api/messages?limit=50&state=held_dnd
- GET /api/messages/:messageId
- GET /api/messages/tasks/:runId
- GET /api/messages/dnd
- PUT /api/messages/dnd/:scope/:scopeKey
- DELETE /api/messages/dnd/:ruleId
- GET /api/messages/policy
- PUT /api/messages/policy
- POST /internal/hermes/outbound
- POST /internal/hermes/task-event
- POST /internal/hermes/inbound

The server remains bound by the caller to localhost. Policy writes validate before persistence, install the snapshot through MessageGatewayService.updatePolicy(), and return the version/hash but never Bridge credentials. Internal hint routes only wake reconciliation and dedupe hint ids; they are not the reliable data source.

All request bodies are capped by Fastify bodyLimit at 1 MiB. Invalid scope, timezone, rate, or unknown policy field returns 400. Bridge transport errors return 503 with stable error code E302/E303 and no token leakage.

- [ ] **Step 4: Run HTTP tests and all Gateway tests**

Run:

~~~powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && corepack pnpm --filter @butler/gateway test && corepack pnpm --filter @butler/gateway exec tsc -p tsconfig.json --noEmit"
~~~

Expected: exit 0; existing alert routes remain unchanged.

- [ ] **Step 5: Commit Task 6**

~~~powershell
git add -- apps/gateway/src/server.ts apps/gateway/src/main.ts apps/gateway/src/index.ts apps/gateway/tests/http.test.ts apps/gateway/tests/message-http.test.ts
git -c user.name="Codex" -c user.email="codex@local.invalid" commit -m "feat(gateway): expose Hermes message policy APIs"
~~~

---

### Task 7: Verify the policy pipeline as one boundary

**Files:**
- Modify only if verification exposes a defect: files from Tasks 1-6.
- Update for confirmed defects fixed during this plan: docs/bug-fixes.md.

**Interfaces:**
- Consumes: Bridge decision replay, Gateway projection/policy/reconciler/service/API.
- Produces: a green policy layer ready for real Hermes installation and PRD UI integration.

- [ ] **Step 1: Run all Python Bridge tests**

~~~powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && PYTHONPATH=packages/adapters/hermes/bridge /home/jiach/.hermes/hermes-agent/venv/bin/python -m unittest discover -s packages/adapters/hermes/bridge/tests -v"
~~~

Expected: all tests pass.

- [ ] **Step 2: Run affected package tests and builds**

~~~powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && ./node_modules/.bin/vitest run --config vitest.focused.config.ts packages/contract/tests/*.test.ts packages/adapters/hermes/tests/*.test.ts apps/gateway/tests/*.test.ts"
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && corepack pnpm --filter @butler/contract exec tsc -p tsconfig.json --noEmit && corepack pnpm --filter @butler/adapter-hermes exec tsc -p tsconfig.json --noEmit && corepack pnpm --filter @butler/gateway exec tsc -p tsconfig.json --noEmit"
~~~

Expected: explicit Vitest output with non-zero discovered test counts and exit 0; all three TypeScript checks exit 0. Package-level `pnpm test` is not accepted as evidence unless the package manifests define a real test script.

- [ ] **Step 3: Run affected-file lint and hygiene checks**

~~~powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && corepack pnpm exec eslint packages/contract/src/messaging.ts packages/contract/tests/messaging.test.ts packages/adapters/hermes/src/messaging apps/gateway/src/message apps/gateway/src/server.ts apps/gateway/src/main.ts apps/gateway/tests/message-*.test.ts"
git diff --check
~~~

Expected: exit 0. Full-repository lint remains a separate baseline issue until the existing 16 unrelated errors are repaired.

- [ ] **Step 4: Confirm real Hermes remains untouched**

~~~powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc "sha256sum /home/jiach/.hermes/hermes-agent/gateway/platforms/weixin.py; cd /home/jiach/.hermes/hermes-agent && git status --short gateway/run.py gateway/platforms/base.py gateway/platforms/weixin.py gateway/platforms/api_server.py plugins/platforms/a2a/adapter.py"
~~~

Expected: weixin.py remains 39b9dccd39dfe4442794c5373433dfb1198e6a195f5d732412e842efa2a4d220 and no new real-Hermes modifications are introduced.

## Following Plans

After this plan is green:

1. docs/superpowers/plans/2026-08-22-hermes-message-runtime-integration.md installs the managed Bridge into real WSL Hermes, adds run/task/API/A2A/inbound hooks, snapshots files, restarts hermes-gateway.service, and proves coverage.
2. docs/superpowers/plans/2026-08-22-hermes-message-product-validation.md connects the web proxy and PRD-style light UI, performs fault injection and controlled real-channel validation, and writes the independent M5 prompt-optimization implementation method.
