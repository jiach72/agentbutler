# Hermes Message Runtime Integration Implementation Plan

> **Status:** approved implementation baseline as of 2026-08-22. Execute with the existing `executing-plans` workflow, one verified task at a time.

**Goal:** Connect the already-tested Butler message policy pipeline to the real WSL Hermes runtime, so every supported outbound path is durably captured, correlated with inbound messages and task runs, delivered only through the Bridge rules, and exposed to the Butler Gateway without claiming coverage that probes have not proved.

**Architecture:** Install a small `gateway/butler_bridge/` runtime package into Hermes. It owns the localhost Bridge server, Linux-side SQLite Outbox, adapter registry, request/run context, and coverage report. Hermes receives narrow semantic-anchor patches that call this package; Butler remains a separate process and reconciles the Outbox over authenticated HTTP. Real platform methods remain reachable only through the in-process native registry. API Server and A2A synchronous replies are recorded as `inline-response`; queued/background delivery remains subject to Butler policy.

**Pinned real baseline:**

- Hermes root: `/home/jiach/.hermes/hermes-agent`
- Hermes HEAD observed before implementation: `b4f978d983`
- systemd user service: `hermes-gateway.service`
- Service command: `/home/jiach/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run`
- Existing user changes that must be preserved: `gateway/platforms/weixin.py` modified and `gateway/platforms/weixin.py.bak-20260820` untracked
- Existing `gateway/platforms/weixin.py` SHA-256 baseline: `39b9dccd39dfe4442794c5373433dfb1198e6a195f5d732412e842efa2a4d220`

## Non-negotiable constraints

- `/home/jiach/.hermes/agent-butler/outbox.sqlite` is the delivery source of truth and stays on the WSL Linux filesystem.
- `queued-push` never falls back to native send when Butler is offline.
- `delivery_unknown` is never retried automatically.
- Weixin keeps its native minimum 30-second terminal protection.
- API Server and A2A synchronous waiter replies do not inherit Weixin pacing or DND.
- A2A sends with no live pending waiter are queued push, not inline response.
- Message optimization remains deterministic; no LLM rewrite is introduced here.
- Token material is read from a mode `0600` file and never logged, serialized into evidence, or returned by health APIs.
- Real Hermes files are snapshotted before writes. Anchor mismatch, hash drift, failed compile, failed coverage probe, or failed service health triggers rollback before restart is considered successful.
- Do not modify or stage the user's untracked `apps/gateway/src/index.ts`. Do not overwrite unrelated untracked files.
- Static declarations do not prove L3. Messaging becomes `ok` only when the live Bridge probe proves protocol, Outbox writability, runtime attach, and required path coverage.

---

### Task 1: Add an idempotent Bridge runtime bootstrap

**Repository files:**

- Create: `packages/adapters/hermes/bridge/agent_butler_bridge/runtime.py`
- Create: `packages/adapters/hermes/bridge/tests/test_runtime.py`
- Modify: `packages/adapters/hermes/bridge/agent_butler_bridge/__init__.py`
- Modify: `packages/adapters/hermes/bridge/agent_butler_bridge/server.py`

**Required behavior:**

- Read configuration only from explicit arguments or `HERMES_BUTLER_*` variables.
- Default bind host is `127.0.0.1`; reject non-loopback hosts unless an explicit unsafe override is present.
- Verify token file ownership/permissions and reject group/world-readable files.
- Create the Outbox parent with `0700`; create token and database files with private permissions.
- Own one process-wide `Outbox`, `NativeRegistry`, `aiohttp.AppRunner`, and `TCPSite`.
- `start()` and `stop()` are idempotent and safe across partial startup failure.
- Register runtime coverage facts in health without exposing secrets.
- Close AppRunner before Outbox during shutdown.

**TDD checks:** startup, double start, double stop, permission rejection, occupied port cleanup, Outbox path location, health before/after attach, and failure without a valid policy snapshot.

**Verification:**

```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && PYTHONPATH=packages/adapters/hermes/bridge /home/jiach/.hermes/hermes-agent/venv/bin/python -m unittest packages/adapters/hermes/bridge/tests/test_runtime.py packages/adapters/hermes/bridge/tests/test_server.py -v"
```

---

### Task 2: Persist inbound, task lifecycle, correlation, attachments, and controlled terminal transitions

**Repository files:**

- Modify: `packages/adapters/hermes/bridge/agent_butler_bridge/outbox.py`
- Create: `packages/adapters/hermes/bridge/agent_butler_bridge/context.py`
- Create: `packages/adapters/hermes/bridge/agent_butler_bridge/spool.py`
- Modify: `packages/adapters/hermes/bridge/agent_butler_bridge/wrapper.py`
- Modify: `packages/adapters/hermes/bridge/agent_butler_bridge/server.py`
- Modify: `packages/adapters/hermes/bridge/tests/test_outbox.py`
- Modify: `packages/adapters/hermes/bridge/tests/test_wrapper.py`
- Create: `packages/adapters/hermes/bridge/tests/test_context.py`
- Create: `packages/adapters/hermes/bridge/tests/test_spool.py`

**Required behavior:**

- `record_inbound()` stores source/channel/account/chat/user/thread/platform message id and received time before Hermes handles the message.
- `begin_run()` creates a UUIDv7 `runId`, binds it to the inbound id/session, emits `started` sequence 1, and records `supersedesRunId` when applicable.
- `append_task_event()` allocates strictly increasing per-run sequences transactionally and dedupes an explicit event key.
- `finish_run()` emits exactly one of `done` or `failed`; `completing` is emitted before a final outbound capture.
- Wrapper metadata falls back to `contextvars` for `runId`, `sessionId`, `inboundMessageId`, kind, priority, and transport.
- Add an auditable Butler-controlled transition to `dead_letter`; it may only target allowed non-terminal/retry states and never silently rewrites `delivery_unknown`.
- Before capture, local attachments are copied to `~/.hermes/agent-butler/spool/<messageId>/`, hashed, size-checked, and committed with the message. Capture fails if spooling fails.
- `GET /v1/tasks/{runId}` returns task events plus inbound/outbound correlation. Existing `changes` remains the durable reconciliation source.

**Failure semantics:** no event sequence gaps from rolled-back transactions; no outbound row may point at a vanished temporary file; attachment and metadata size limits fail closed.

**Verification:** run all Bridge unit tests and a restart test that proves `delivering -> delivery_unknown`, task sequence continuity, and attachment persistence.

---

### Task 3: Classify and attach real adapter instances without bypasses

**Repository files:**

- Create: `packages/adapters/hermes/bridge/agent_butler_bridge/hermes_hooks.py`
- Modify: `packages/adapters/hermes/bridge/agent_butler_bridge/registry.py`
- Modify: `packages/adapters/hermes/bridge/agent_butler_bridge/wrapper.py`
- Create: `packages/adapters/hermes/bridge/tests/test_hermes_hooks.py`
- Modify: `packages/adapters/hermes/bridge/tests/test_wrapper.py`

**Required behavior:**

- A single `attach_runtime_adapter(adapter, platform, profile)` function derives a stable adapter id including profile/account identity.
- Re-attaching the same object is idempotent; reconnect-created objects replace only their own adapter id binding.
- Weixin and ordinary chat platforms default to `queued-push`.
- API Server is registered for health/coverage but its `send()` is not treated as the HTTP response path.
- A2A checks the live `_pending`/`_pending_order` registry at send time: a final reply with a live waiter is `inline-response`; no waiter is `queued-push`.
- Wrap every supported user-visible exit, including direct media/document methods. Unsupported exits appear as `degraded` in coverage rather than being silently called “attached”.
- Native originals remain in memory only. Bridge `/deliver` still accepts only an existing `messageId + attemptId + contentHash`.

**Coverage tests:** primary adapter, reconnect adapter, multiplex profile adapter, A2A waiter/no-waiter, synthetic edit, direct media path, and duplicate attach.

---

### Task 4: Generate narrow, reversible Hermes runtime patches and coverage probes

**Repository files:**

- Create: `packages/adapters/hermes/bridge/agent_butler_bridge/installer.py`
- Create: `packages/adapters/hermes/bridge/agent_butler_bridge/patches.py`
- Create: `packages/adapters/hermes/bridge/tests/test_installer.py`
- Create: `packages/adapters/hermes/bridge/tests/fixtures/hermes_runtime/`

**Real Hermes targets after tests pass:**

- `gateway/run.py`
- `gateway/platforms/base.py`
- `gateway/platforms/api_server.py`
- `plugins/platforms/a2a/adapter.py`
- `gateway/butler_bridge/` (managed copy of the Bridge package)

**Patch responsibilities:**

1. Start the Bridge runtime inside the gateway lifecycle and stop it during gateway shutdown.
2. Invoke the central attach hook after every adapter creation path: primary startup, reconnect, plugin, and multiplex profile.
3. Record inbound before `BasePlatformAdapter.handle_message()` dispatches, then bind the eventual run in `_run_agent_inner()`.
4. Emit structured progress from `TurnRunner.progress_callback()` without turning each tool callback into a user message.
5. Capture final/failure lifecycle at the actual turn boundary.
6. Capture API Server session chat, chat completions, responses, and their SSE final assembled result as `inline-response`; chunks are not individual business messages.
7. Let the A2A hook classify live waiter versus out-of-band push.

**Installer rules:**

- `check` performs read-only anchor and import validation.
- `install` writes a timestamped manifest containing pre/post hashes and backup paths.
- Exact already-installed patches are idempotent.
- Partial or ambiguous anchors abort with no writes.
- `rollback` restores only files in that manifest and verifies restored hashes.
- Never touch `gateway/platforms/weixin.py` for this slice unless a later coverage test proves an unavoidable gap and the existing user-modified SHA still matches the approved baseline.

**Coverage probe output:** a machine-readable matrix for adapter attach, inbound, run lifecycle, progress, queued send, API JSON, API SSE, A2A waiter, A2A push, edit, and media. Any required row that is absent prevents L3 `ok`.

---

### Task 5: Compose the Butler Gateway message runtime without touching user entry files

**Repository files:**

- Create: `apps/gateway/src/message/runtime.ts`
- Create: `apps/gateway/tests/message-runtime.test.ts`
- Modify: `apps/gateway/src/server.ts` only if lifecycle ownership cannot remain fully injected
- Modify: `apps/gateway/src/message/service.ts`

**Required behavior:**

- `createHermesMessageRuntime()` reads Bridge URL, instance id, Hermes root, token file path, projection db path, and poll interval from validated options/environment.
- Read the token value from a file; do not require or encourage a plaintext token environment variable.
- Construct `createHermesMessaging()`, `MessagePolicyStore`, and `MessageGatewayService`, then expose `{service, store, start, stop}`.
- Start installs the deterministic policy before processing queued messages.
- Stop prevents new cycles, waits for the in-flight cycle to settle with a bounded timeout, then closes the projection store.
- `createGatewayServer({messageService, messageStore})` remains the HTTP exposure point.
- Provide a dedicated tracked runtime launcher or documented import command. Do not edit or stage the user's untracked `apps/gateway/src/main.ts` or `apps/gateway/src/index.ts`.

**Tests:** missing config, unreadable/private token file, startup rollback, one start/stop owner, policy install, persisted projection restart, and HTTP routes backed by the real runtime objects.

---

### Task 6: Make Hermes L3 capability status probe-driven

**Repository files:**

- Create: `packages/adapters/hermes/src/messaging/capability.ts`
- Create: `packages/adapters/hermes/tests/messaging-capability.test.ts`
- Modify: `packages/adapters/hermes/src/index.ts`
- Modify: `packages/contract/src/manifest.ts` only if the current report type cannot represent coverage detail

**Required behavior:**

- No Bridge configuration: preserve current L2 result and report messaging unavailable/not installed.
- Bridge unreachable, auth failure, protocol mismatch, Outbox read-only, no adapters, or incomplete required coverage: `messaging=degraded`, effective level no higher than 2.
- Live authenticated Bridge with complete required coverage: `messaging=ok`, effective level 3.
- Report anomalies without token values or raw sensitive paths.
- Manifest can declare support for probe-driven messaging, but runtime status remains the authority.

---

### Task 7: Verify the repository boundary before touching real Hermes

**Required commands:**

```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && PYTHONPATH=packages/adapters/hermes/bridge /home/jiach/.hermes/hermes-agent/venv/bin/python -m unittest discover -s packages/adapters/hermes/bridge/tests -p 'test_*.py' -v"
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && corepack pnpm --filter @butler/contract exec vitest run --config ../../vitest.focused.config.ts tests && corepack pnpm --filter @butler/adapter-hermes exec vitest run --config ../../vitest.focused.config.ts tests && corepack pnpm --filter @butler/gateway exec vitest run --config ../../vitest.focused.config.ts tests/message-*.test.ts"
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/c/Users/jiach/Documents/Agent Butler' && corepack pnpm --filter @butler/contract exec tsc -p tsconfig.json --noEmit && corepack pnpm --filter @butler/adapter-hermes exec tsc -p tsconfig.json --noEmit && corepack pnpm --filter @butler/gateway exec tsc -p tsconfig.json --noEmit"
git diff --check
```

Also run installer fixture tests, compile the generated managed package, and prove `check` leaves both repository and real Hermes unchanged.

Stop before deployment if any focused regression fails or if the real baseline changed since the snapshot.

---

### Task 8: Snapshot, install, restart, and perform real WSL acceptance

**Pre-write evidence:**

- Record Hermes HEAD, `git status --short`, target hashes, service unit/drop-ins, active PID, current ports, and current enabled platforms.
- Reconfirm the existing Weixin modified/untracked state is unchanged from the approved baseline.
- Create a timestamped backup directory outside the Hermes Git worktree with a manifest and SHA-256 values.

**Install:**

1. Create `/home/jiach/.hermes/agent-butler` with mode `0700`.
2. Create/rotate the Bridge token file with mode `0600` without printing its contents.
3. Install the managed Bridge package and semantic patches.
4. Add a systemd user drop-in containing only non-secret paths/port; use a credential file path for the token.
5. Run Python compile, installer `check`, and coverage probe before restart.
6. Restart only `hermes-gateway.service`.

**Post-restart acceptance:**

- Service is active/running and logs show no import/startup traceback.
- Authenticated Bridge health returns protocol v1, writable Outbox, attached adapters, and the coverage matrix.
- Butler Gateway installs the policy, reconciles, and exposes non-static `/api/messages/*` data.
- With Butler stopped, a controlled queued push lands in Outbox and does not reach the native channel; after Butler resumes it is delivered once.
- Restart at ready/delivering boundaries proves no Butler-initiated duplicate and preserves `delivery_unknown` for uncertain sends.
- Long task progress becomes a small deterministic digest; final reply wins over pending progress.
- DND, urgent/failure bypass, release aggregation, AIMD congestion/recovery, and Weixin 30-second terminal protection behave as specified.
- API Server non-stream, SSE, and Responses API are captured once per final result with no artificial Weixin delay.
- A2A live waiter is inline; out-of-band push is queued.
- Inbound id -> run id -> events -> outbound/provider id is queryable.
- Save messageId, attemptId, providerMessageId, timestamps, service logs, and API evidence with secrets redacted.

If a real external-channel send would contact a person or system not explicitly placed in scope, stop before that final action and request confirmation. Local Outbox/API Server/A2A fixture validation may continue.

---

### Task 9: Hand off to PRD UI and M5 as separate completion gates

Runtime integration completion does not mean the product is complete.

- UI gate: the PRD light visual system must consume the real message APIs, show explicit empty/error/degraded states, and pass browser/runtime validation.
- M5 gate: create a separate prompt-optimization spec, baseline evaluation set, candidate-diff workflow, approval, canary, metrics, and rollback. M5 is not part of the per-message send path.
- Final audit must distinguish implemented, test-proven, live-proven, degraded, and not implemented. Only live-proven paths may be described as “消息网关正常工作”.

