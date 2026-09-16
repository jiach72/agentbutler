#!/usr/bin/env node
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const HERMES_CONTROL_ACTIONS = new Set([
  "status",
  "start-hermes",
  "stop-hermes",
  "restart-hermes",
  "cleanup-orphan-gateways",
]);
export const ORPHAN_GATEWAY_PATTERNS = ["hermes_cli.main gateway run", "tui_gateway.entry"];
const MAX_BODY_BYTES = 8 * 1024;
const MAX_CRON_BODY_BYTES = 64 * 1024;

// Versioned against the installed Hermes f94a7a1 source. Unknown layouts fail closed.
// Do not call list_jobs/list_executions: those "read" APIs repair storage/create tables.
export const HERMES_CRON_PYTHON = String.raw`
import sys, os, json, re, sqlite3, hashlib, hmac, subprocess, contextlib, io, logging, math
from pathlib import Path
from datetime import datetime
import fcntl

VERSION = "hermes-f94a7a1-cron-v1"
HASHES = {
 "cron/jobs.py": "bedc0a7bad306df456b6c84d44b26ebfad2320725d2175f6cf6512b9b5d7ef9a",
 "cron/executions.py": "1c7af4651cece5cdd8995464ba5d18c88a3b9c23cfceed757626b73c01e06535",
 "cron/incidents.py": "5f614becfe4dac5a468988bc643724caf89c6a9bb978b2dd6c5590049b24a0d1",
 "hermes_cli/cron.py": "b6d73c18eec7062f33b115855ad1f7990404e24cd3f947a8bb3cfffd84bc3d4b",
 "tools/cronjob_tools.py": "bae3b050ec3922656f4b4d3be86f0c5566922246545d38c8c72d0e45433df274",
 "hermes_time.py": "44867d31c4fcc09c248a9958f08c4ac57acf61cc9b20a9f2c8515c80de96ba69"
}
repo, home, executable = (Path(v).resolve() for v in sys.argv[1:4])
os.environ["HERMES_HOME"] = str(home)
os.environ.pop("HERMES_SESSION_KEY", None)
sys.path.insert(0, str(repo))
sys.dont_write_bytecode = True
logging.disable(logging.CRITICAL)

# Hermes imports can initialize config directories. Prevent implicit host writes;
# only our private journal/backup directory is writable in this helper process.
# Actual Hermes mutations run in the separate fixed-argv CLI after the backup.
def read_only_audit(event, args):
 paths = []
 if event == "open":
  path, mode, flags = args
  if isinstance(path,(str,bytes)) and (flags & (os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_APPEND)):
   paths = [path]
 elif event in ("os.mkdir","os.remove","os.rmdir","os.chmod","os.chown","os.utime","os.truncate"):
  paths = [args[0]]
 elif event in ("os.rename","os.link","os.symlink"): paths = list(args[:2])
 for p in paths:
  if isinstance(p,int): raise PermissionError("readonly")
  resolved = Path(os.fsdecode(p)).resolve()
  state = home/"agent-butler/cron-control-v1"
  if resolved != Path(os.devnull) and resolved != state and state not in resolved.parents:
   # Parent dirs may be created only for the bridge journal, never cron storage.
   if not (event=="os.mkdir" and resolved==home/"agent-butler"):
    raise PermissionError("readonly")
sys.addaudithook(read_only_audit)

class Rejected(Exception):
 def __init__(self, code): self.code = code

def reject(code): raise Rejected(code)
def obj(v, required, optional=()):
 if not isinstance(v, dict) or not set(required) <= v.keys() or not v.keys() <= set(required) | set(optional): reject("invalid_request")
def text(v, n, nonempty=True):
 if not isinstance(v, str) or len(v) > n or (nonempty and not v.strip()) or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", v): reject("invalid_request")
 return v
def ident(v, minimum=1):
 if not isinstance(v, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", v) or len(v) < minimum: reject("invalid_request")
 return v
def boolean(v):
 if type(v) is not bool: reject("invalid_request")
 return v
def integer(v, lo, hi):
 if type(v) is not int or not lo <= v <= hi: reject("invalid_request")
 return v
def schedule_shape(s):
 if not isinstance(s, dict): reject("invalid_request")
 kind = s.get("kind")
 if kind == "interval":
  obj(s, ("kind", "everyMinutes")); integer(s["everyMinutes"], 1, 525600)
 elif kind in ("daily", "weekdays", "weekly", "advanced"):
  obj(s, ("kind", "timezone", "expression") if kind == "advanced" else
      ("kind", "timezone", "time", "weekdays") if kind == "weekly" else ("kind", "timezone", "time"))
  if not re.fullmatch(r"[A-Za-z0-9_+/-]{1,80}", text(s["timezone"], 80)): reject("invalid_request")
  if kind == "advanced":
   if not re.fullmatch(r"[A-Za-z0-9*,/-]+(?: [A-Za-z0-9*,/-]+){4}", text(s["expression"], 120)): reject("invalid_schedule")
  elif not isinstance(s["time"], str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", s["time"]): reject("invalid_schedule")
  if kind == "weekly":
   days = s["weekdays"]
   if not isinstance(days, list) or not 1 <= len(days) <= 7: reject("invalid_schedule")
   for day in days: integer(day, 0, 6)
   if len(set(days)) != len(days): reject("invalid_schedule")
 else: reject("invalid_schedule")
def validate_request(q):
 action = q.get("action") if isinstance(q, dict) else None
 if action in ("status", "list", "incidents"): obj(q, ("action",))
 elif action == "runs": obj(q, ("action", "id", "limit")); ident(q["id"]); integer(q["limit"], 1, 500)
 elif action == "detail": obj(q, ("action", "id")); ident(q["id"])
 elif action == "preview": obj(q, ("action", "schedule")); schedule_shape(q["schedule"])
 elif action in ("create", "edit", "pause", "resume", "run", "remove"):
  keys = ["action", "requestId"] + ([] if action == "create" else ["id"])
  if action in ("create", "edit"): keys += ["draft"]
  if action == "remove": keys += ["confirmName"]
  obj(q, keys); ident(q["requestId"], 16)
  if action != "create": ident(q["id"])
  if action == "remove": text(q["confirmName"], 120)
  if action in ("create", "edit"):
   d = q["draft"]; obj(d, ("name", "prompt", "schedule", "delivery"), ("advanced",))
   text(d["name"], 120); text(d["prompt"], 16000)
   if "\n" in d["name"] or "\r" in d["name"]: reject("invalid_request")
   schedule_shape(d["schedule"]); obj(d["delivery"], ("enabled",)); boolean(d["delivery"]["enabled"])
   a = d.get("advanced", {}); obj(a, (), ("model", "skills", "workdir"))
   if "model" in a and not re.fullmatch(r"(?:[A-Za-z0-9][A-Za-z0-9._:/-]*)?", text(a["model"],160,False)): reject("invalid_request")
   if "skills" in a:
    if not isinstance(a["skills"], list) or len(a["skills"]) > 20: reject("invalid_request")
    for skill in a["skills"]:
     if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}", text(skill,80)): reject("invalid_request")
   if "workdir" in a:
    workdir = text(a["workdir"],512,False)
    if workdir and (not workdir.startswith("/") or "\n" in workdir or "\r" in workdir): reject("invalid_request")
 else: reject("invalid_request")
 return q

def envelope(**kw): return dict(schemaVersion=1, supported=True, reachable=True, **kw)
def failure(q, code):
 base = envelope(reason=code)
 if code == "unsupported_version": base["supported"] = False
 if code == "data_unavailable": base["reachable"] = False
 a = q.get("action")
 if a == "status": return dict(base, schedulerRunning=None, activeCount=0, todayRunCount=0, failedTaskCount=0, nextRunAt=None,
   heartbeatAgeSeconds=None, timezone=None, writesSupported=False, runSupported=False)
 if a == "detail": return dict(base, editable=False, draft=None)
 if a == "preview": return dict(base, scheduleLabel=None, nextRunAt=None, timezone=None)
 if "requestId" in q: return dict(base, requestId=q["requestId"], taskId=q.get("id"),
   outcome="unknown" if code in ("outcome_unknown", "operation_in_progress") else "failed")
 return dict(base, items=[])

def read_bytes(path, limit):
 with path.open("rb") as f:
  data = f.read(limit + 1)
 if len(data) > limit: reject("data_unavailable")
 return data
def read_jobs():
 p = home / "cron/jobs.json"
 if not p.exists(): return []
 data = json.loads(read_bytes(p, 8*1024*1024))
 if not isinstance(data, dict) or not isinstance(data.get("jobs"), list) or len(data["jobs"]) > 1000: reject("data_unavailable")
 jobs = data["jobs"]
 ids = set()
 for j in jobs:
  if not isinstance(j, dict): reject("data_unavailable")
  i = ident(j.get("id"))
  if i in ids: reject("data_unavailable")
  ids.add(i)
 return jobs
def db_rows(sql, params=(), table="executions"):
 p = home / "cron/executions.db"
 if not p.exists(): return []
 conn = sqlite3.connect(p.as_uri()+"?mode=ro", uri=True, timeout=2)
 try:
  conn.execute("PRAGMA query_only=ON"); conn.row_factory = sqlite3.Row
  if not conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone(): return []
  return [dict(r) for r in conn.execute(sql, params).fetchall()]
 finally: conn.close()
def iso(v):
 if v is None: return None
 if not isinstance(v,str): reject("data_unavailable")
 dt = datetime.fromisoformat(v.replace("Z","+00:00"))
 if dt.tzinfo is None:
  from hermes_time import get_timezone
  tz = get_timezone()
  if tz is None: reject("timezone_unknown")
  dt = dt.replace(tzinfo=tz)
 return dt.isoformat()
def tz_name():
 from hermes_time import get_timezone, get_timezone_name
 tz = get_timezone()
 if tz is not None: return str(tz)
 if get_timezone_name(): return None
 # Hermes falls back to server-local time. Use an actual IANA system zone,
 # never guess from abbreviations (CST) or from a single numeric offset.
 from zoneinfo import ZoneInfo
 name=os.environ.get("TZ","").lstrip(":")
 if not name:
  local=Path("/etc/localtime").resolve().as_posix()
  if "/zoneinfo/" in local: name=local.split("/zoneinfo/",1)[1]
 try:
  zone=ZoneInfo(name)
  if datetime.now(zone).utcoffset()!=datetime.now().astimezone().utcoffset(): return None
  return str(zone)
 except Exception: return None
def builtin_provider():
 # Do not use the CLI resolver here: it silently falls back to builtin when
 # plugin/config initialization fails, which is not proof that writes are safe.
 from hermes_cli.config_effective import load_user_config_effective
 config=load_user_config_effective(home/"config.yaml",fail_closed=True)
 cron=config.get("cron") or {}
 if not isinstance(cron,dict): reject("data_unavailable")
 return cron.get("provider","") in ("","builtin","in-process","inprocess",None)
def schedule_arg(s):
 schedule_shape(s)
 if s["kind"] == "interval": return "every "+str(s["everyMinutes"])+"m"
 tz = tz_name()
 if tz is None: reject("timezone_unknown")
 if tz != s["timezone"]: reject("timezone_mismatch")
 if s["kind"] == "advanced": return s["expression"]
 hour, minute = map(int,s["time"].split(":"))
 days = "*" if s["kind"]=="daily" else "1-5" if s["kind"]=="weekdays" else ",".join(str(x) for x in sorted(s["weekdays"]))
 return f"{minute} {hour} * * {days}"
def preview(s):
 from cron.jobs import parse_schedule, compute_next_run
 try:
  arg = schedule_arg(s); parsed = parse_schedule(arg); nxt = compute_next_run(parsed)
 except Rejected: raise
 except Exception: reject("invalid_schedule")
 return envelope(scheduleLabel=arg, nextRunAt=iso(nxt), timezone=tz_name())
def job_schedule(j):
 s = j.get("schedule")
 if not isinstance(s,dict): reject("data_unavailable")
 if s.get("kind") == "cron" and isinstance(s.get("expr"),str) and re.fullmatch(r"[A-Za-z0-9*,/-]+(?: [A-Za-z0-9*,/-]+){4}",s["expr"]): return s["expr"]
 if s.get("kind") == "interval" and type(s.get("minutes")) is int and 1 <= s["minutes"] <= 525600: return "every "+str(s["minutes"])+"m"
 if s.get("kind") == "once": return "once"
 return "unsupported"
def edit_reason(j):
 if any(j.get(k) for k in ("script","no_agent","monitor_script","monitor_url","context_from","enabled_toolsets","continuity")): return "advanced_job"
 if job_schedule(j) in ("once", "unsupported"): return "unsupported_schedule"
 delivery = j.get("deliver") or ["local"]
 if delivery not in ("local","origin",["local"],["origin"]): return "unsupported_delivery"
 if tz_name() is None: return "timezone_unknown"
 if not isinstance(j.get("prompt"),str) or not j["prompt"].strip(): return "advanced_job"
 return None
def public_name(j):
 n = j.get("name"); p = j.get("prompt")
 if not isinstance(n,str) or not n.strip() or len(n)>120 or re.search(r"[\x00-\x1f\x7f]|https?://|sk-[A-Za-z0-9]", n): return j["id"]
 # Hermes can synthesize the name from the first 50 prompt characters.
 if isinstance(p,str) and p.strip().startswith(n.strip()): return j["id"]
 return n
def summary(j, latest=None):
 raw = j.get("last_status")
 state = "never" if raw is None and j.get("last_run_at") is None else "unknown"
 if raw == "ok": state = "success"
 if raw in ("error","failed"): state = "failed"
 # Hermes keeps this distinct: the run succeeded, only the delivery failed (not green, not a run failure).
 if raw == "delivery_failed": state = "delivery_failed"
 if latest and latest["status"] in ("failed","unknown"): state = "failed" if latest["status"]=="failed" else "unknown"
 if latest and latest["status"] in ("claimed","running"): state = "running"
 # delivery_queued is not proof of successful delivery.
 if raw == "delivery_queued" and state != "running": state = "unknown"
 enabled = j.get("enabled",True); boolean(enabled)
 streak = j.get("failure_streak") or 0; integer(streak,0,2147483647)
 delivery = j.get("deliver") or ["local"]
 why = edit_reason(j)
 result = dict(id=j["id"],name=public_name(j),enabled=enabled,scheduleLabel=job_schedule(j),
   nextRunAt=iso(j.get("next_run_at")),lastRunAt=iso(j.get("last_run_at")),lastStatus=state,
   failureStreak=streak,deliveryEnabled=delivery not in ("local",["local"]),editable=why is None)
 if why: result["editableReason"] = why
 return result
def find_job(q, jobs):
 j = next((j for j in jobs if j["id"]==q["id"]),None)
 if j is None: reject("not_found")
 return j
def detail(j):
 why = edit_reason(j)
 if why: return envelope(editable=False,draft=None,reason="not_editable")
 s=j["schedule"]; tz=tz_name()
 schedule = dict(kind="interval",everyMinutes=s["minutes"]) if s["kind"]=="interval" else dict(kind="advanced",expression=s["expr"],timezone=tz)
 advanced={}
 for source,target in (("model","model"),("workdir","workdir"),("skills","skills")):
  if j.get(source): advanced[target]=j[source]
 draft=dict(name=public_name(j),prompt=j["prompt"],schedule=schedule,delivery=dict(enabled=summary(j)["deliveryEnabled"]))
 if advanced: draft["advanced"]=advanced
 validate_request(dict(action="create",requestId="validate-12345678",draft=draft))
 return envelope(editable=True,draft=draft)
def latest_execution_states(ids):
 if not ids: return {}
 rows=db_rows("SELECT id,job_id,status FROM (SELECT id,job_id,status,ROW_NUMBER() OVER(PARTITION BY job_id ORDER BY claimed_at DESC,id DESC) AS rn FROM executions WHERE job_id IN ("+",".join("?" for _ in ids)+")) WHERE rn=1",ids)
 return {r["job_id"]:r["status"] for r in rows}
def hermes_tz():
 from hermes_time import get_timezone
 return get_timezone()
def status_counts(jobs):
 # Hermes records "delivery_failed" for a run that SUCCEEDED but could not be delivered
 # (failure_streak stays untouched), so only real agent-run failures count as failed tasks.
 latest=latest_execution_states([j["id"] for j in jobs])
 failed=sum(1 for j in jobs if j.get("last_status") in ("error","failed") or latest.get(j["id"])=="failed")
 tz=hermes_tz()
 today=(datetime.now(tz) if tz is not None else datetime.now().astimezone()).date()
 runs=0
 for row in db_rows("SELECT started_at,claimed_at FROM executions ORDER BY claimed_at DESC LIMIT 5000"):
  stamp=row.get("started_at") or row.get("claimed_at")
  if not isinstance(stamp,str): continue
  try: at=datetime.fromisoformat(stamp.replace("Z","+00:00"))
  except ValueError: continue
  if at.tzinfo is None: at=at.replace(tzinfo=tz) if tz is not None else at.astimezone()
  if at.astimezone(tz).date()==today: runs+=1
 return runs,failed
def read_action(q):
 a=q["action"]
 if a=="preview": return preview(q["schedule"])
 if a=="runs":
  find_job(q,read_jobs())
  rows=db_rows("SELECT id,job_id,status,claimed_at,started_at,finished_at FROM executions WHERE job_id=? ORDER BY claimed_at DESC,id DESC LIMIT ?",(q["id"],q["limit"]))
  return envelope(items=[dict(id=r["id"],taskId=r["job_id"],status=r["status"],claimedAt=iso(r["claimed_at"]),startedAt=iso(r["started_at"]),finishedAt=iso(r["finished_at"])) for r in rows])
 if a=="incidents":
  rows=db_rows("SELECT id,job_id,state,failure_type,first_seen_at,last_seen_at FROM cron_incidents ORDER BY last_seen_at DESC,id DESC LIMIT 1001",table="cron_incidents")
  if len(rows)>1000: reject("data_unavailable")
  return envelope(items=[dict(id=r["id"],taskId=r["job_id"],state=r["state"],failureType=r["failure_type"],firstSeenAt=iso(r["first_seen_at"]),lastSeenAt=iso(r["last_seen_at"])) for r in rows])
 jobs=read_jobs()
 if a=="detail": return detail(find_job(q,jobs))
 if a=="list":
  states=latest_execution_states([j["id"] for j in jobs])
  return envelope(items=[summary(j,{"status":states[j["id"]]} if j["id"] in states else None) for j in jobs])
 from cron.jobs import get_ticker_heartbeat_age, get_ticker_success_age, TICKER_INTERVAL_SECONDS
 hb=get_ticker_heartbeat_age(); ok=get_ticker_success_age()
 if hb is not None and not math.isfinite(hb): reject("data_unavailable")
 # Probe the existing runtime lock read-only; Hermes' own helper opens r+/a+
 # and can delete an inaccessible lock. Missing lock is unknown, not healthy.
 alive=False
 lock_path=home/"gateway.lock"
 if lock_path.exists():
  with lock_path.open("r") as lock:
   try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB); fcntl.flock(lock,fcntl.LOCK_UN)
   except BlockingIOError: alive=True
 builtin=builtin_provider()
 running=(alive is True and hb is not None and hb <= TICKER_INTERVAL_SECONDS*3+20 and
   (ok is None or ok <= TICKER_INTERVAL_SECONDS*3+20)) if builtin else None
 active=[j for j in jobs if j.get("enabled",True)]
 today_runs,failed_tasks=status_counts(jobs)
 times=[iso(j["next_run_at"]) for j in active if j.get("next_run_at")]
 return envelope(schedulerRunning=running,activeCount=len(active),todayRunCount=today_runs,failedTaskCount=failed_tasks,
   nextRunAt=min(times,key=lambda v:datetime.fromisoformat(v).timestamp()) if times else None,
   heartbeatAgeSeconds=hb,timezone=tz_name(),writesSupported=builtin,runSupported=builtin,
   **({} if builtin else {"reason":"unsupported_scheduler"}))

def durable(path, value, exclusive=False):
 flags=os.O_WRONLY|os.O_CREAT|(os.O_EXCL if exclusive else os.O_TRUNC)
 fd=os.open(path,flags,0o600)
 try:
  with os.fdopen(fd,"w",encoding="utf-8") as f: json.dump(value,f,separators=(",",":")); f.flush(); os.fsync(f.fileno())
 finally: pass
def sync_dir(path):
 fd=os.open(path,os.O_RDONLY)
 try: os.fsync(fd)
 finally: os.close(fd)
def atomic(path, value):
 tmp=path.with_suffix(".tmp")
 durable(tmp,value)
 os.replace(tmp,path); sync_dir(path.parent)
def command(q):
 a=q["action"]
 if a not in ("create","edit"): return [str(executable),"cron", "remove" if a=="remove" else a,"--",q["id"]]
 d=q["draft"]; p=preview(d["schedule"])
 args=[str(executable),"cron",a,"--name="+d["name"],"--deliver="+("origin" if d["delivery"]["enabled"] else "local")]
 adv=d.get("advanced",{})
 # Existing model/skills/workdir are retained unless explicitly provided.
 for key in ("model","workdir"):
  if key in adv: args.append("--"+key+"="+adv[key])
 if "skills" in adv:
  if a=="edit" and not adv["skills"]: args.append("--clear-skills")
  for skill in adv["skills"]: args.append("--skill="+skill)
 if a=="edit": args += ["--schedule="+p["scheduleLabel"],"--prompt="+d["prompt"],"--",q["id"]]
 else: args += ["--",p["scheduleLabel"],d["prompt"]]
 return args
def run_action(q):
 if not builtin_provider(): reject("unsupported_scheduler")
 jobs=read_jobs()
 target=find_job(q,jobs)
 args=[str(executable),"cron","run","--",q["id"]]
 env=dict(os.environ,HERMES_HOME=str(home))
 env.pop("HERMES_SESSION_KEY",None); env.pop("HERMES_ACCEPT_HOOKS",None)
 started_t=time.time()
 try:
  completed=subprocess.run(args,cwd=repo,env=env,stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60,check=False,shell=False,text=True)
  duration_ms=int((time.time()-started_t)*1000)
  out_txt=(completed.stdout or "").strip()
  err_txt=(completed.stderr or "").strip()
  out_txt=re.sub(r'sk-[A-Za-z0-9_-]{20,}', '[REDACTED_KEY]', out_txt)[:4000]
  err_txt=re.sub(r'sk-[A-Za-z0-9_-]{20,}', '[REDACTED_KEY]', err_txt)[:4000]
  if completed.returncode==0:
   return envelope(requestId=q["requestId"],taskId=q["id"],outcome="succeeded",
     durationMs=duration_ms,exitCode=0,outputSnippet=out_txt,errorSnippet=err_txt if err_txt else None)
  else:
   return envelope(requestId=q["requestId"],taskId=q["id"],outcome="failed",
     durationMs=duration_ms,exitCode=completed.returncode,outputSnippet=out_txt,errorSnippet=err_txt)
 except subprocess.TimeoutExpired:
  return failure(q,"timeout")
 except Exception:
  return failure(q,"outcome_unknown")
def write_action(q):
 if q["action"]=="run": return run_action(q)
 state=home/"agent-butler/cron-control-v1"
 state.mkdir(parents=True,exist_ok=True,mode=0o700)
 os.chmod(state,0o700)
 with (state/"lock").open("a") as lock:
  try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError: reject("operation_in_progress")
  secret_path=state/"digest.key"
  if not secret_path.exists():
   fd=os.open(secret_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
   with os.fdopen(fd,"wb") as f: f.write(os.urandom(32)); f.flush(); os.fsync(f.fileno())
   sync_dir(state)
  digest=hmac.new(secret_path.read_bytes(),json.dumps(q,sort_keys=True,separators=(",",":")).encode(),hashlib.sha256).hexdigest()
  journal=state/(q["requestId"]+".json")
  if journal.exists():
   try: old=json.loads(journal.read_text())
   except Exception: reject("outcome_unknown")
   if not isinstance(old,dict) or "digest" not in old: reject("outcome_unknown")
   if old["digest"]!=digest: reject("idempotency_conflict")
   return old.get("result") or failure(q,"outcome_unknown")
  # Fence all later writes while a previous CLI outcome is uncertain.
  for entry in state.glob("*.json"):
   try: prior=json.loads(entry.read_text())
   except Exception: reject("outcome_unknown")
   if prior.get("result",{}).get("outcome","unknown")=="unknown": reject("outcome_unknown")
  jobs=read_jobs()
  before=find_job(q,jobs) if q["action"]!="create" else None
  if q["action"]=="edit" and edit_reason(before): reject("not_editable")
  if q["action"]=="remove" and q["confirmName"]!=public_name(before): reject("confirmation_mismatch")
  if not builtin_provider(): reject("unsupported_scheduler")
  args=command(q)
  # Record intent durably before any mutation. No prompt, name, argv or raw error enters this file.
  record=dict(adapter=VERSION,digest=digest,action=q["action"],taskId=q.get("id"),at=datetime.now().astimezone().isoformat())
  durable(journal,record,exclusive=True); sync_dir(state)
  try:
   source=home/"cron/jobs.json"
   backup=state/(q["requestId"]+".jobs.backup")
   raw=read_bytes(source,8*1024*1024) if source.exists() else b'{"jobs":[]}'
   fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
   with os.fdopen(fd,"wb") as f: f.write(raw); f.flush(); os.fsync(f.fileno())
   sync_dir(state)
  except Exception:
   result=failure(q,"backup_failed"); record["result"]=result; atomic(journal,record); return result
  result=failure(q,"outcome_unknown")
  try:
   env=dict(os.environ,HERMES_HOME=str(home))
   env.pop("HERMES_SESSION_KEY",None); env.pop("HERMES_ACCEPT_HOOKS",None)
   # Never print/capture CLI output: it may echo prompt, provider URLs or secrets.
   completed=subprocess.run(args,cwd=repo,env=env,stdin=subprocess.DEVNULL,
     stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30,check=False,shell=False)
   after=read_jobs(); task_id=q.get("id")
   if q["action"]=="create":
    known={j["id"] for j in jobs}; candidates=[j for j in after if j["id"] not in known]
    candidates=[j for j in candidates if j.get("name")==q["draft"]["name"] and j.get("prompt")==q["draft"]["prompt"]]
    task_id=candidates[0]["id"] if len(candidates)==1 else None
   current=next((j for j in after if j["id"]==task_id),None)
   verified=False
   if q["action"]=="remove": verified=current is None
   elif q["action"]=="pause": verified=current is not None and current.get("enabled") is False
   elif q["action"]=="resume": verified=current is not None and current.get("enabled") is True
   elif current:
    draft=q["draft"]
    verified=(current.get("name")==draft["name"] and current.get("prompt")==draft["prompt"] and
      job_schedule(current)==schedule_arg(draft["schedule"]) and summary(current)["deliveryEnabled"]==draft["delivery"]["enabled"])
    for key,val in draft.get("advanced",{}).items(): verified=verified and (current.get(key) or ( [] if key=="skills" else ""))==val
   if completed.returncode==0 and verified:
    result=envelope(requestId=q["requestId"],taskId=task_id,outcome="succeeded")
   elif completed.returncode!=0 and after==jobs: result=failure(q,"write_failed")
  except Exception:
   pass
  record["result"]=result
  atomic(journal,record)
  # The journal itself is the safe durable audit: identity, action, timestamp, outcome only.
  return result

q={}
try:
 q=validate_request(json.loads(sys.stdin.read(65537)))
 for rel, expected in HASHES.items():
  if hashlib.sha256((repo/rel).read_bytes()).hexdigest()!=expected: reject("unsupported_version")
 # Match the CLI's profile .env timezone without importing or exposing its secrets.
 env_file=home/".env"
 if "HERMES_TIMEZONE" not in os.environ and env_file.exists():
  from dotenv import dotenv_values
  timezone_value=dotenv_values(stream=io.StringIO(read_bytes(env_file,1024*1024).decode())).get("HERMES_TIMEZONE")
  if timezone_value: os.environ["HERMES_TIMEZONE"]=timezone_value
 with open(os.devnull,"w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
  result=write_action(q) if "requestId" in q else read_action(q)
except Rejected as e: result=failure(q,e.code)
except Exception: result=failure(q,"outcome_unknown" if "requestId" in q else "data_unavailable")
print(json.dumps(result,allow_nan=False,separators=(",",":")))
`;

function validCronRequest(q) {
  if (!q || typeof q !== "object" || Array.isArray(q)) return false;
  const fields = {
    list: ["action"], status: ["action"], incidents: ["action"],
    runs: ["action", "id", "limit"], detail: ["action", "id"], preview: ["action", "schedule"],
    create: ["action", "requestId", "draft"], edit: ["action", "id", "requestId", "draft"],
    pause: ["action", "id", "requestId"], resume: ["action", "id", "requestId"],
    run: ["action", "id", "requestId"], remove: ["action", "id", "requestId", "confirmName"],
  };
  const allowed = Object.hasOwn(fields, q.action) ? fields[q.action] : null;
  if (!allowed || Object.keys(q).length !== allowed.length || !allowed.every((key) => Object.hasOwn(q, key))) return false;
  if ("id" in q && (typeof q.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(q.id))) return false;
  if ("requestId" in q && (typeof q.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,79}$/.test(q.requestId))) return false;
  if ("limit" in q && (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 500)) return false;
  if ("schedule" in q && !validCronSchedule(q.schedule)) return false;
  if ("draft" in q && !validCronDraft(q.draft)) return false;
  if ("confirmName" in q && !cronName(q.confirmName)) return false;
  return true;
}

const cronRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const cronText = (v, max) => typeof v === "string" && v.length <= max &&
  [...v].every((char) => { const n = char.charCodeAt(0); return n >= 32 && n !== 127 || n === 9 || n === 10 || n === 13; });
const cronName = (v) => cronText(v, 120) && v.trim() !== "" && !/[\r\n]/.test(v);
const cronId = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v);
const cronKeys = (v, keys, optional = []) => cronRecord(v) && keys.every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => [...keys, ...optional].includes(k));
function validCronSchedule(s) {
  if (!cronRecord(s)) return false;
  if (s.kind === "interval") return cronKeys(s, ["kind", "everyMinutes"]) && Number.isInteger(s.everyMinutes) && s.everyMinutes >= 1 && s.everyMinutes <= 525600;
  if (!["daily", "weekdays", "weekly", "advanced"].includes(s.kind) ||
    typeof s.timezone !== "string" || !/^[A-Za-z0-9_+/-]{1,80}$/.test(s.timezone)) return false;
  if (s.kind === "advanced") return cronKeys(s, ["kind", "expression", "timezone"]) &&
    typeof s.expression === "string" && s.expression.length <= 120 && /^[A-Za-z0-9*,/-]+(?: [A-Za-z0-9*,/-]+){4}$/.test(s.expression);
  if (!cronKeys(s, s.kind === "weekly" ? ["kind", "time", "timezone", "weekdays"] : ["kind", "time", "timezone"]) ||
    typeof s.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s.time)) return false;
  return s.kind !== "weekly" || (Array.isArray(s.weekdays) && s.weekdays.length >= 1 && s.weekdays.length <= 7 &&
    new Set(s.weekdays).size === s.weekdays.length && s.weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6));
}
function validCronDraft(d) {
  if (!cronKeys(d, ["name", "prompt", "schedule", "delivery"], ["advanced"]) || !cronName(d.name) ||
    !cronText(d.prompt, 16000) || !d.prompt.trim() || !validCronSchedule(d.schedule) ||
    !cronKeys(d.delivery, ["enabled"]) || typeof d.delivery.enabled !== "boolean") return false;
  if (!Object.hasOwn(d, "advanced")) return true;
  const a = d.advanced;
  return cronKeys(a, [], ["model", "skills", "workdir"]) &&
    (!("model" in a) || (typeof a.model === "string" && a.model.length <= 160 && /^(?:[A-Za-z0-9][A-Za-z0-9._:/-]*)?$/.test(a.model))) &&
    (!("workdir" in a) || (cronText(a.workdir, 512) && (a.workdir === "" || (a.workdir.startsWith("/") && !/[\r\n]/.test(a.workdir))))) &&
    (!("skills" in a) || (Array.isArray(a.skills) && a.skills.length <= 20 &&
      a.skills.every((s) => typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(s))));
}
const CRON_REASONS = new Set(["unsupported_version", "unsupported_scheduler", "invalid_request", "invalid_schedule",
  "timezone_mismatch", "timezone_unknown", "not_found", "not_editable", "confirmation_mismatch",
  "manual_run_not_supported", "backup_failed", "write_failed", "outcome_unknown", "idempotency_conflict",
  "operation_in_progress", "data_unavailable"]);
const cronTime = (v) => v === null || (typeof v === "string" && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)));
const cronBool = (v) => typeof v === "boolean";
const cronCount = (v) => Number.isSafeInteger(v) && v >= 0;
function pickCron(v, shape) {
  if (!cronRecord(v)) throw new Error("invalid_response");
  return Object.fromEntries(Object.entries(shape).map(([key, check]) => {
    if (!check(v[key])) throw new Error("invalid_response");
    return [key, v[key]];
  }));
}
function cronResponse(q, raw) {
  const base = pickCron(raw, { schemaVersion: (v) => v === 1, supported: cronBool, reachable: cronBool });
  if ("reason" in raw) {
    if (!CRON_REASONS.has(raw.reason)) throw new Error("invalid_response");
    base.reason = raw.reason;
  }
  if ((!base.supported || !base.reachable) && !base.reason) throw new Error("invalid_response");
  if (q.action === "status") return { ...base, ...pickCron(raw, {
    schedulerRunning: (v) => v === null || cronBool(v), activeCount: cronCount,
    todayRunCount: cronCount, failedTaskCount: cronCount, nextRunAt: cronTime,
    heartbeatAgeSeconds: (v) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0),
    timezone: (v) => v === null || (typeof v === "string" && /^[A-Za-z0-9_+/-]{1,80}$/.test(v)),
    writesSupported: cronBool, runSupported: cronBool,
  }) };
  if (q.action === "preview") return { ...base, ...pickCron(raw, {
    scheduleLabel: (v) => v === null || cronText(v, 160), nextRunAt: cronTime,
    timezone: (v) => v === null || (typeof v === "string" && /^[A-Za-z0-9_+/-]{1,80}$/.test(v)),
  }) };
  if (q.action === "detail") {
    const detail = pickCron(raw, { editable: cronBool, draft: (v) => v === null || validCronDraft(v) });
    if (detail.editable !== (detail.draft !== null)) throw new Error("invalid_response");
    return { ...base, ...detail };
  }
  if ("requestId" in q) {
    const result = pickCron(raw, { requestId: (v) => v === q.requestId,
      taskId: (v) => v === null || (cronId(v) && (!q.id || v === q.id)),
      outcome: (v) => ["succeeded", "failed", "unknown"].includes(v),
      outputSnippet: (v) => v === undefined || (typeof v === "string" && v.length <= 4000),
      errorSnippet: (v) => v === undefined || (typeof v === "string" && v.length <= 4000),
      durationMs: (v) => v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0),
      exitCode: (v) => v === undefined || (typeof v === "number" && Number.isInteger(v)),
    });
    if (result.outcome === "succeeded" && (!base.reachable || !base.supported || base.reason || !result.taskId)) throw new Error("invalid_response");
    return { ...base, ...result };
  }
  if (!Array.isArray(raw.items) || raw.items.length > (q.action === "runs" ? q.limit : 1000)) throw new Error("invalid_response");
  const shapes = {
    list: { id: cronId, name: cronName, enabled: cronBool, scheduleLabel: (v) => cronText(v, 160),
      nextRunAt: cronTime, lastRunAt: cronTime, lastStatus: (v) => ["success","failed","delivery_failed","running","never","unknown"].includes(v),
      failureStreak: cronCount, deliveryEnabled: cronBool, editable: cronBool },
    runs: { id: cronId, taskId: (v) => v === q.id, status: (v) => ["claimed","running","completed","failed","unknown"].includes(v),
      claimedAt: cronTime, startedAt: cronTime, finishedAt: cronTime },
    incidents: { id: cronId, taskId: cronId, state: (v) => ["detected","alerted","closed"].includes(v),
      failureType: (v) => ["rate_limit","timeout","auth","delivery","config","script","agent","unknown"].includes(v),
      firstSeenAt: cronTime, lastSeenAt: cronTime },
  };
  return { ...base, items: raw.items.map((row) => {
    const item = pickCron(row, shapes[q.action]);
    if (q.action === "list" && "editableReason" in row) {
      if (!["advanced_job","unsupported_schedule","unsupported_delivery","timezone_unknown"].includes(row.editableReason)) throw new Error("invalid_response");
      item.editableReason = row.editableReason;
    }
    return item;
  }) };
}

function defaultCron(rootPath, repoPath) {
  return async (body) => {
    const venv = ["venv", ".venv"].map((dir) => join(repoPath, dir, "bin"))
      .find((dir) => existsSync(join(dir, "python")) && existsSync(join(dir, "hermes")));
    if (!venv) throw new Error("cron_unavailable");
    return new Promise((resolve, reject) => {
      const child = execFile(join(venv, "python"),
        ["-c", HERMES_CRON_PYTHON, repoPath, rootPath, join(venv, "hermes")],
        { timeout: 40_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, shell: false },
        (error, stdout) => {
          if (error) return reject(new Error("cron_unavailable"));
          try { resolve(JSON.parse(stdout)); } catch { reject(new Error("cron_invalid_response")); }
        });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(body));
    });
  };
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function tokenMatches(expected, supplied) {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearerToken(value) {
  const match = /^Bearer\s+(.+)$/i.exec(value ?? "");
  return match?.[1]?.trim() ?? "";
}

function defaultSystemctl(timeoutMs) {
  return (args) =>
    new Promise((resolve) => {
      execFile("systemctl", ["--user", ...args], { timeout: timeoutMs }, (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      });
    });
}

function defaultProcess(timeoutMs) {
  return (command, args) =>
    new Promise((resolve) => {
      execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      });
    });
}

function readRecordedGatewayPid(rootPath) {
  try {
    const value = JSON.parse(readFileSync(join(rootPath, "gateway.pid"), "utf8"));
    return Number.isInteger(value?.pid) && value.pid > 0 ? value.pid : null;
  } catch {
    return null;
  }
}

async function cleanupOrphanGateways(rootPath, runProcess) {
  const pids = new Set();
  for (const pattern of ORPHAN_GATEWAY_PATTERNS) {
    const result = await runProcess("pgrep", ["-f", pattern]);
    if (result.code !== 0) continue;
    for (const line of result.stdout.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  const sorted = [...pids].sort((left, right) => left - right);
  if (sorted.length === 0) return { cleanedPids: [], mainPid: null };

  const recordedPid = readRecordedGatewayPid(rootPath);
  const mainPid = recordedPid !== null && pids.has(recordedPid) ? recordedPid : sorted[0];
  const cleanedPids = [];
  for (const pid of sorted) {
    if (pid === mainPid) continue;
    const result = await runProcess("kill", [String(pid)]);
    if (result.code !== 0) throw new Error(`kill ${pid} failed`);
    cleanedPids.push(pid);
  }
  return { cleanedPids, mainPid };
}

/**
 * 创建只允许 Hermes 生命周期固定动作的宿主控制 HTTP 服务。
 * 不接受命令行、服务名、路径或其他用户可控参数。
 */
export function createHermesControlBridgeServer(options) {
  const readToken = options.readToken ?? (() => readFileSync(options.tokenFile, "utf8").trim());
  const runSystemctl = options.runSystemctl ?? defaultSystemctl(options.timeoutMs);
  const runProcess = options.runProcess ?? defaultProcess(options.timeoutMs);
  const rootPath = options.rootPath ?? `${process.env.HOME}/.hermes`;
  const runCron = options.runCron ?? defaultCron(rootPath, options.hermesRepoPath ?? join(homedir(), ".hermes", "hermes-agent"));

  async function status() {
    const result = await runSystemctl(["is-active", options.unit]);
    return { active: result.code === 0 && result.stdout.trim() === "active", unit: options.unit };
  }

  async function action(name) {
    if (name === "status") return status();
    if (name === "cleanup-orphan-gateways") {
      const cleanup = await cleanupOrphanGateways(rootPath, runProcess);
      return { ...(await status()), ...cleanup };
    }
    const command = name.replace("-hermes", "");
    const result = await runSystemctl([command, options.unit]);
    if (result.code !== 0) throw new Error("systemctl failed");
    return status();
  }

  return createServer(async (req, res) => {
    if (req.method !== "POST" || !["/v1/control", "/v1/cron"].includes(req.url)) return json(res, 404, { error: "not_found" });
    const cron = req.url === "/v1/cron";

    let expected;
    try {
      expected = readToken();
    } catch {
      return json(res, 503, { error: "token_unavailable" });
    }
    const supplied = bearerToken(req.headers.authorization);
    if (!expected || !supplied || !tokenMatches(expected, supplied)) return json(res, 401, { error: "unauthorized" });

    const chunks = [];
    let bytes = 0;
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > (cron ? MAX_CRON_BODY_BYTES : MAX_BODY_BYTES)) return json(res, 413, { error: "body_too_large" });
        chunks.push(chunk);
      }
    } catch { return json(res, 400, { error: "invalid_request" }); }
    const raw = Buffer.concat(chunks).toString("utf8");

    let name;
    try {
      const body = JSON.parse(raw);
      if (cron) {
        if (!validCronRequest(body)) return json(res, 400, { error: "invalid_request" });
        try {
          const result = cronResponse(body, await runCron(body));
          const code = result.reason === "invalid_request" || result.reason === "invalid_schedule" || result.reason === "timezone_mismatch" || result.reason === "confirmation_mismatch" ? 400 :
            result.reason === "not_found" ? 404 : ["outcome_unknown","idempotency_conflict","operation_in_progress"].includes(result.reason) ? 409 : 200;
          return json(res, code, result);
        } catch { return json(res, 502, { error: "cron_unavailable" }); }
      }
      name = body.action;
    } catch {
      return json(res, 400, { error: "invalid_json" });
    }
    if (typeof name !== "string" || !HERMES_CONTROL_ACTIONS.has(name)) {
      return json(res, 400, { error: "action_not_allowed" });
    }

    try {
      return json(res, 200, await action(name));
    } catch {
      return json(res, 502, { error: "control_failed" });
    }
  });
}

function startFromEnvironment() {
  const host = process.env.BUTLER_HERMES_CONTROL_HOST || "127.0.0.1";
  const port = Number(process.env.BUTLER_HERMES_CONTROL_PORT || "8756");
  const tokenFile = process.env.BUTLER_HERMES_CONTROL_TOKEN_FILE || `${process.env.HOME}/.hermes/agent-butler/control.token`;
  const unit = process.env.BUTLER_HERMES_CONTROL_UNIT || "hermes-gateway.service";
  const rootPath = process.env.BUTLER_HERMES_CONTROL_ROOT || `${process.env.HOME}/.hermes`;
  const timeoutMs = Math.max(1000, Number(process.env.BUTLER_HERMES_CONTROL_TIMEOUT_MS || "30000"));
  const server = createHermesControlBridgeServer({ tokenFile, unit, rootPath, timeoutMs });
  server.listen(port, host, () => console.log(`Hermes control bridge listening on ${host}:${port}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startFromEnvironment();
