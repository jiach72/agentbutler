// Run in WSL: node --test scripts/hermes-cron-host.integration.mjs
// Only the temporary HERMES_HOME below is written; the installed Hermes source is read-only.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { HERMES_CRON_PYTHON, createHermesControlBridgeServer } from "./hermes-control-bridge.mjs";

const repo = process.env.HERMES_TEST_REPO ?? join(homedir(), ".hermes", "hermes-agent");
const bin = ["venv", ".venv"].map((p) => join(repo, p, "bin"))
  .find((p) => existsSync(join(p, "python")) && existsSync(join(p, "hermes")));
if (!bin) throw new Error("Installed Hermes venv is required");
const homes = [];
function home() {
  const dir = mkdtempSync(join(tmpdir(), "butler-cron-test-"));
  homes.push(dir);
  writeFileSync(join(dir, "config.yaml"), "timezone: Asia/Shanghai\n");
  return dir;
}
after(() => { for (const dir of homes) rmSync(dir, { recursive: true, force: true }); });
function call(root, request) {
  const result = spawnSync(join(bin, "python"),
    ["-c", HERMES_CRON_PYTHON, repo, root, join(bin, "hermes")],
    { input: JSON.stringify(request), encoding: "utf8", timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.status, 0, "helper must return a sanitized envelope");
  assert.equal(result.stderr, "", "no raw errors may escape the host helper");
  return JSON.parse(result.stdout);
}
const draft = {
  name: "butler isolated test", prompt: "INTEGRATION_PROMPT_SECRET Do not send anything.",
  schedule: { kind: "interval", everyMinutes: 525600 }, delivery: { enabled: false },
};
const jobs = (root) => JSON.parse(readFileSync(join(root, "cron", "jobs.json"), "utf8")).jobs;

test("real CLI isolated CRUD, explicit clear and durable idempotency across helper restarts", () => {
  const root = home();
  const create = { action: "create", requestId: "create-isolated-0001", draft };
  const result = call(root, create);
  assert.equal(result.outcome, "succeeded", JSON.stringify(result));
  assert.equal(jobs(root).length, 1);
  assert.deepEqual(call(root, create), result);
  assert.equal(jobs(root).length, 1);
  assert.equal(call(root, { ...create, draft: { ...draft, name: "different" } }).reason, "idempotency_conflict");
  const id = result.taskId;
  assert.equal(call(root, { action: "pause", id, requestId: "pause-isolated-0001" }).outcome, "succeeded");
  assert.equal(jobs(root)[0].enabled, false);
  assert.equal(call(root, { action: "resume", id, requestId: "resume-isolated-0001" }).outcome, "succeeded");
  assert.equal(jobs(root)[0].enabled, true);
  const changed = { ...draft, name: "--help ; $(touch forbidden)", prompt: "--help\nINTEGRATION_PROMPT_SECRET",
    advanced: { model: "", workdir: "", skills: [] } };
  assert.equal(call(root, { action: "edit", id, requestId: "edit-isolated-0001", draft: changed }).outcome, "succeeded");
  assert.equal(jobs(root)[0].name, changed.name);
  const detail = call(root, { action: "detail", id });
  assert.equal(detail.editable, true);
  assert.equal(detail.draft.prompt, changed.prompt);
  assert.equal(call(root, { action: "remove", id, requestId: "delete-isolated-0001", confirmName: "wrong" }).reason, "confirmation_mismatch");
  assert.equal(jobs(root).length, 1);
  assert.equal(call(root, { action: "remove", id, requestId: "delete-isolated-0001", confirmName: changed.name }).outcome, "succeeded");
  assert.equal(jobs(root).length, 0);
  const state = join(root, "agent-butler", "cron-control-v1");
  assert.equal(readdirSync(state).filter((f) => f.endsWith(".jobs.backup")).length, 5);
  for (const f of readdirSync(state).filter((f) => f.endsWith(".json"))) {
    const content = readFileSync(join(state, f), "utf8");
    assert.ok(!content.includes("INTEGRATION_PROMPT_SECRET"));
    assert.ok(!content.includes("prompt"));
    assert.ok(!content.includes("forbidden"));
  }
});

test("read-only projection preserves files, includes advanced jobs, and excludes prompt/error/URL fields", () => {
  const root = home();
  mkdirSync(join(root, "cron"));
  const record = { id: "abcd1234", name: "Sensitive generated prompt", prompt: "Sensitive generated prompt and secret",
    script: "test.py", no_agent: true, enabled: true, schedule: { kind: "cron", expr: "0 9 * * *" },
    next_run_at: "2026-10-01T09:00:00+08:00", last_run_at: null, last_status: null, failure_streak: 0,
    base_url: "https://secret.example", deliver: ["local"], last_error: "PROMPT_ERROR_SECRET" };
  const file = join(root, "cron", "jobs.json");
  writeFileSync(file, JSON.stringify({ jobs: [record] }));
  const before = readFileSync(file);
  const response = call(root, { action: "list" });
  assert.equal(response.items.length, 1);
  assert.equal(response.items[0].name, "abcd1234");
  assert.equal(response.items[0].editable, false);
  assert.equal(response.items[0].editableReason, "advanced_job");
  assert.equal(response.items[0].lastStatus, "never");
  assert.ok(!JSON.stringify(response).includes("secret"));
  assert.equal(call(root, { action: "detail", id: "abcd1234" }).draft, null);
  assert.equal(call(root, { action: "edit", id: "abcd1234", requestId: "edit-advanced-0001", draft }).reason, "not_editable");
  assert.deepEqual(readFileSync(file), before);
  assert.equal(existsSync(join(root, "cron", "executions.db")), false);
});

test("preview uses Hermes parser and rejects unsupported timezone and unsafe run", () => {
  const root = home();
  const schedule = { kind: "daily", time: "09:30", timezone: "Asia/Shanghai" };
  const result = call(root, { action: "preview", schedule });
  assert.equal(result.scheduleLabel, "30 9 * * *");
  assert.equal(result.timezone, "Asia/Shanghai");
  assert.ok(result.nextRunAt);
  assert.equal(call(root, { action: "preview", schedule: { ...schedule, timezone: "UTC" } }).reason, "timezone_mismatch");
  assert.equal(call(root, { action: "run", id: "abc123", requestId: "run-isolated-0001" }).reason, "not_found");
  assert.equal(existsSync(join(root, "cron")), false);
});

test("uncertain creation is never retried after restart and fences subsequent writes", () => {
  const root = home();
  const request = { action: "create", requestId: "unknown-isolated-0001", draft };
  assert.equal(call(root, request).outcome, "succeeded");
  const journal = join(root, "agent-butler", "cron-control-v1", request.requestId + ".json");
  const record = JSON.parse(readFileSync(journal, "utf8"));
  delete record.result; // Simulate process death after Hermes committed but before final journal persistence.
  writeFileSync(journal, JSON.stringify(record));
  assert.equal(call(root, request).outcome, "unknown");
  assert.equal(call(root, { ...request, requestId: "unknown-isolated-0002" }).outcome, "unknown");
  assert.equal(jobs(root).length, 1);
});

test("backup failure aborts before invoking Hermes", () => {
  const root = home();
  const state = join(root, "agent-butler", "cron-control-v1");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "backup-isolated-0001.jobs.backup"), "already exists");
  assert.equal(call(root, { action: "create", requestId: "backup-isolated-0001", draft }).reason, "backup_failed");
  assert.equal(existsSync(join(root, "cron", "jobs.json")), false);
});

test("durable runs and incidents are read without schema writes or leaking stored errors", () => {
  const root = home();
  mkdirSync(join(root, "cron"));
  writeFileSync(join(root, "cron", "jobs.json"), JSON.stringify({ jobs: [{
    id: "abc123", name: "Task", prompt: "PRIVATE_PROMPT", enabled: true,
    schedule: { kind: "interval", minutes: 30 }, last_status: "ok", last_run_at: "2026-09-01T00:00:00Z",
  }] }));
  const fixture = spawnSync(join(bin, "python"), ["-c", `
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute("CREATE TABLE executions(id TEXT,job_id TEXT,status TEXT,claimed_at TEXT,started_at TEXT,finished_at TEXT,error TEXT)")
c.execute("INSERT INTO executions VALUES('run123','abc123','failed','2026-09-02T00:00:00Z',NULL,NULL,'PRIVATE_PROMPT_ERROR')")
c.execute("CREATE TABLE cron_incidents(id TEXT,job_id TEXT,state TEXT,failure_type TEXT,first_seen_at TEXT,last_seen_at TEXT,error TEXT,output_file TEXT)")
c.execute("INSERT INTO cron_incidents VALUES('inc123','abc123','detected','auth','2026-09-02T00:00:00Z','2026-09-02T00:00:00Z','PRIVATE_PROMPT_ERROR','PRIVATE_OUTPUT_PATH')")
c.commit()
c.close()
`, join(root, "cron", "executions.db")], { encoding: "utf8" });
  assert.equal(fixture.status, 0);
  const before = readFileSync(join(root, "cron", "executions.db"));
  const runs = call(root, { action: "runs", id: "abc123", limit: 20 });
  assert.equal(runs.items[0].status, "failed");
  const incidents = call(root, { action: "incidents" });
  assert.equal(incidents.items[0].failureType, "auth");
  const list = call(root, { action: "list" });
  assert.equal(list.items[0].lastStatus, "failed");
  assert.ok(!JSON.stringify([runs, incidents, list]).includes("PRIVATE"));
  assert.deepEqual(readFileSync(join(root, "cron", "executions.db")), before);
  assert.deepEqual(readdirSync(join(root, "cron")).sort(), ["executions.db", "jobs.json"]);
});

test("status counts only today's runs and only real run failures", () => {
  const root = home();
  mkdirSync(join(root, "cron"));
  const job = (id, lastStatus) => ({ id, name: id, prompt: "PRIVATE_PROMPT_" + id, enabled: true,
    schedule: { kind: "interval", minutes: 30 }, last_status: lastStatus, last_run_at: "2026-09-15T00:00:00Z" });
  writeFileSync(join(root, "cron", "jobs.json"), JSON.stringify({ jobs: [
    job("jobok0001", "ok"), job("jobdely001", "delivery_failed"),
    job("joberr0001", "error"), job("joblegacy1", "failed"), job("jobdetfm01", "ok"),
  ] }));
  const fixture = spawnSync(join(bin, "python"), ["-c", `
import sqlite3, sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
now = datetime.now(ZoneInfo("Asia/Shanghai"))
conn = sqlite3.connect(sys.argv[1])
conn.execute("CREATE TABLE executions(id TEXT,job_id TEXT,status TEXT,claimed_at TEXT,started_at TEXT,finished_at TEXT,error TEXT)")
for row in (
    ("run-today-a", "jobok0001", "completed", now),
    ("run-today-b", "jobdely001", "completed", now - timedelta(hours=1)),
    ("run-latest-failed", "jobdetfm01", "failed", now - timedelta(days=2)),
    ("run-older-ok", "jobdetfm01", "completed", now - timedelta(days=3)),
    ("run-yesterday", "joberr0001", "failed", now - timedelta(days=1)),
):
    conn.execute("INSERT INTO executions VALUES(?,?,?,?,?,?,?)",
                 (row[0], row[1], row[2], row[3].isoformat(), row[3].isoformat(), row[3].isoformat(), None))
conn.commit()
conn.close()
`, join(root, "cron", "executions.db")], { encoding: "utf8" });
  assert.equal(fixture.status, 0, fixture.stderr);
  const before = readFileSync(join(root, "cron", "executions.db"));
  const status = call(root, { action: "status" });
  assert.equal(status.supported, true);
  assert.equal(status.todayRunCount, 2);
  assert.equal(status.failedTaskCount, 3);
  const list = call(root, { action: "list" });
  assert.equal(list.items.filter((item) => item.lastStatus === "failed").length, status.failedTaskCount);
  // Delivery failure means the run itself succeeded, so it must not be counted as a failed task.
  assert.equal(list.items.find((item) => item.id === "jobdely001").lastStatus, "delivery_failed");
  assert.ok(!JSON.stringify([status, list]).includes("PRIVATE"));
  assert.deepEqual(readFileSync(join(root, "cron", "executions.db")), before);
});
test("live read-only bridge matches installed Hermes jobs and never exposes task content", {
  skip: process.env.HERMES_LIVE_READ !== "1",
}, async () => {
  const root = join(homedir(), ".hermes");
  const before = readFileSync(join(root, "cron", "jobs.json"));
  const records = JSON.parse(before).jobs;
  const server = createHermesControlBridgeServer({ rootPath: root, hermesRepoPath: repo, readToken: () => "ephemeral-test-token" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const request = async (body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/cron`, {
        method: "POST", headers: { authorization: "Bearer ephemeral-test-token", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.reachable, true, JSON.stringify(payload));
      assert.equal(payload.supported, true);
      assert.ok(!JSON.stringify(payload).includes('"prompt"'));
      assert.ok(!JSON.stringify(payload).includes('"base_url"'));
      return payload;
    };
    const list = await request({ action: "list" });
    const status = await request({ action: "status" });
    assert.equal(list.items.length, records.length);
    assert.equal(status.activeCount, records.filter((j) => j.enabled !== false).length);
    assert.equal(status.runSupported, status.writesSupported);
    assert.equal(status.failedTaskCount, list.items.filter((item) => item.lastStatus === "failed").length);
    assert.ok(Number.isInteger(status.todayRunCount) && status.todayRunCount >= 0);
    if (records.length) await request({ action: "runs", id: records[0].id, limit: 20 });
    await request({ action: "incidents" });
    assert.deepEqual(readFileSync(join(root, "cron", "jobs.json")), before);
    console.log(`live verification: jobs=${list.items.length} active=${status.activeCount} schedulerRunning=${status.schedulerRunning} timezone=${status.timezone} writesSupported=${status.writesSupported}`);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
