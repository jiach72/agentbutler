"""Crash-safe SQLite Outbox for the Hermes-side Butler Bridge."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Mapping


OUTBOX_STATES = {
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
}
DECISION_STATES = {
    "held_dnd",
    "held_pacing",
    "ready",
    "absorbed",
    "policy_error",
    "cancelled",
}
TERMINAL_STATES = {"delivered", "absorbed", "dead_letter", "cancelled"}

DDL = """
CREATE TABLE IF NOT EXISTS bridge_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound_messages (
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
  decision_id TEXT,
  transform_trace_json TEXT NOT NULL DEFAULT '[]',
  last_error TEXT,
  captured_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbound_state_available
  ON outbound_messages(state, available_at, sequence);
CREATE INDEX IF NOT EXISTS idx_outbound_run ON outbound_messages(run_id, sequence);

CREATE TABLE IF NOT EXISTS outbound_decisions (
  decision_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES outbound_messages(message_id),
  applied_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbound_decisions_message
  ON outbound_decisions(message_id, applied_at);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  attempt_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES outbound_messages(message_id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_delivery_message
  ON delivery_attempts(message_id, started_at);

CREATE TABLE IF NOT EXISTS task_events (
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

CREATE TABLE IF NOT EXISTS inbound_messages (
  inbound_message_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  change_sequence INTEGER NOT NULL UNIQUE,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbound_decisions (
  inbound_message_id TEXT PRIMARY KEY REFERENCES inbound_messages(inbound_message_id),
  decision_json TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
"""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _read_required_string(payload: Mapping[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key} must be a non-empty string")
    return value


class Outbox:
    """Thread-safe Outbox with explicit crash recovery semantics."""

    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._closed = False
        self._conn = sqlite3.connect(
            str(self.db_path),
            timeout=5.0,
            isolation_level=None,
            check_same_thread=False,
        )
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.executescript(DDL)
        with self._transaction():
            self._migrate_outbound_messages_locked()
            self._backfill_outbound_decisions_locked()
            self._ensure_sequence_seed_locked()
            now = _utc_now()
            stale = self._conn.execute(
                "SELECT message_id, active_attempt_id FROM outbound_messages WHERE state = 'delivering'"
            ).fetchall()
            for row in stale:
                attempt_id = row["active_attempt_id"]
                if attempt_id:
                    self._conn.execute(
                        """UPDATE delivery_attempts
                           SET finished_at = ?, outcome = 'unknown', error = ?
                           WHERE attempt_id = ? AND finished_at IS NULL""",
                        (now, "recovered stale delivering after Bridge restart", attempt_id),
                    )
            self._conn.execute(
                """UPDATE outbound_messages
                   SET state = 'delivery_unknown', active_attempt_id = NULL,
                       last_error = ?, updated_at = ?
                   WHERE state = 'delivering'""",
                ("recovered stale delivering after Bridge restart", now),
            )

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._conn.close()

    @contextmanager
    def _transaction(self) -> Iterator[None]:
        with self._lock:
            self._ensure_open()
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield
            except BaseException:
                self._conn.rollback()
                raise
            else:
                self._conn.commit()

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("Outbox is closed")

    def _ensure_sequence_seed_locked(self) -> None:
        row = self._conn.execute(
            "SELECT value FROM bridge_meta WHERE key = 'next_change_sequence'"
        ).fetchone()
        if row is not None:
            return
        maxima = self._conn.execute(
            """SELECT MAX(value) AS max_value FROM (
                 SELECT COALESCE(MAX(sequence), 0) AS value FROM outbound_messages
                 UNION ALL SELECT COALESCE(MAX(change_sequence), 0) FROM task_events
                 UNION ALL SELECT COALESCE(MAX(change_sequence), 0) FROM inbound_messages
               )"""
        ).fetchone()
        next_value = int(maxima["max_value"] or 0) + 1
        self._conn.execute(
            "INSERT INTO bridge_meta(key, value) VALUES ('next_change_sequence', ?)",
            (str(next_value),),
        )

    def _migrate_outbound_messages_locked(self) -> None:
        columns = {
            row["name"]
            for row in self._conn.execute("PRAGMA table_info(outbound_messages)").fetchall()
        }
        if "decision_id" not in columns:
            self._conn.execute("ALTER TABLE outbound_messages ADD COLUMN decision_id TEXT")
        self._conn.execute(
            """CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_decision_id
               ON outbound_messages(decision_id)
               WHERE decision_id IS NOT NULL"""
        )

    def _backfill_outbound_decisions_locked(self) -> None:
        self._conn.execute(
            """INSERT OR IGNORE INTO outbound_decisions(decision_id, message_id, applied_at)
               SELECT decision_id, message_id, updated_at
               FROM outbound_messages
               WHERE decision_id IS NOT NULL"""
        )

    def _next_sequence_locked(self) -> int:
        row = self._conn.execute(
            "SELECT value FROM bridge_meta WHERE key = 'next_change_sequence'"
        ).fetchone()
        if row is None:
            self._ensure_sequence_seed_locked()
            row = self._conn.execute(
                "SELECT value FROM bridge_meta WHERE key = 'next_change_sequence'"
            ).fetchone()
        assert row is not None
        value = int(row["value"])
        self._conn.execute(
            "UPDATE bridge_meta SET value = ? WHERE key = 'next_change_sequence'",
            (str(value + 1),),
        )
        return value

    def capture(self, envelope: Mapping[str, Any]) -> dict[str, Any]:
        message_id = _read_required_string(envelope, "messageId")
        content = _read_required_string(envelope, "content")
        expected_hash = _read_required_string(envelope, "contentSha256")
        actual_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
        if actual_hash != expected_hash:
            raise ValueError("content hash does not match content")

        required = {
            key: _read_required_string(envelope, key)
            for key in (
                "instanceId",
                "adapterId",
                "channel",
                "chatId",
                "sessionId",
                "messageKind",
                "transport",
                "priority",
                "capturedAt",
            )
        }
        if required["transport"] not in {"queued-push", "inline-response"}:
            raise ValueError("transport must be queued-push or inline-response")
        metadata = envelope.get("metadata", {})
        if not isinstance(metadata, Mapping):
            raise ValueError("metadata must be an object")
        metadata_json = _canonical_json(dict(metadata))

        with self._transaction():
            existing = self._conn.execute(
                "SELECT * FROM outbound_messages WHERE message_id = ?", (message_id,)
            ).fetchone()
            if existing is not None:
                if existing["content_sha256"] != expected_hash:
                    raise ValueError("messageId already exists with a different content hash")
                return {"deduped": True, "message": self._message_from_row(existing)}

            sequence = self._next_sequence_locked()
            now = _utc_now()
            self._conn.execute(
                """INSERT INTO outbound_messages (
                     message_id, sequence, instance_id, adapter_id, channel, account_id,
                     chat_id, thread_id, session_id, run_id, inbound_message_id,
                     message_kind, transport, priority, content, content_sha256,
                     reply_to, metadata_json, state, captured_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                             'captured', ?, ?)""",
                (
                    message_id,
                    sequence,
                    required["instanceId"],
                    required["adapterId"],
                    required["channel"],
                    envelope.get("accountId"),
                    required["chatId"],
                    envelope.get("threadId"),
                    required["sessionId"],
                    envelope.get("runId"),
                    envelope.get("inboundMessageId"),
                    required["messageKind"],
                    required["transport"],
                    required["priority"],
                    content,
                    expected_hash,
                    envelope.get("replyTo"),
                    metadata_json,
                    required["capturedAt"],
                    now,
                ),
            )
            inserted = self._conn.execute(
                "SELECT * FROM outbound_messages WHERE message_id = ?", (message_id,)
            ).fetchone()
            assert inserted is not None
            return {"deduped": False, "message": self._message_from_row(inserted)}

    def get(self, message_id: str) -> dict[str, Any] | None:
        with self._lock:
            self._ensure_open()
            row = self._conn.execute(
                "SELECT * FROM outbound_messages WHERE message_id = ?", (message_id,)
            ).fetchone()
            return None if row is None else self._message_from_row(row)

    def is_writable(self) -> bool:
        try:
            with self._lock:
                self._ensure_open()
                self._conn.execute("BEGIN IMMEDIATE")
                self._conn.execute(
                    """INSERT INTO bridge_meta(key, value) VALUES ('health_probe', ?)
                       ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
                    (_utc_now(),),
                )
                self._conn.rollback()
            return True
        except (RuntimeError, sqlite3.Error):
            return False

    def list_changes(self, after_sequence: int, limit: int = 100) -> dict[str, Any]:
        if after_sequence < 0:
            raise ValueError("after_sequence must be non-negative")
        bounded_limit = max(1, min(int(limit), 200))
        with self._lock:
            self._ensure_open()
            changes = self._conn.execute(
                """SELECT sequence AS change_sequence FROM outbound_messages WHERE sequence > ?
                   UNION ALL
                   SELECT change_sequence FROM task_events WHERE change_sequence > ?
                   UNION ALL
                   SELECT change_sequence FROM inbound_messages WHERE change_sequence > ?
                   ORDER BY change_sequence ASC LIMIT ?""",
                (after_sequence, after_sequence, after_sequence, bounded_limit),
            ).fetchall()
            if not changes:
                return {
                    "afterSequence": after_sequence,
                    "nextSequence": after_sequence,
                    "items": [],
                    "taskEvents": [],
                    "inbound": [],
                }
            cutoff = int(changes[-1]["change_sequence"])
            messages = self._conn.execute(
                """SELECT * FROM outbound_messages
                   WHERE sequence > ? AND sequence <= ? ORDER BY sequence ASC""",
                (after_sequence, cutoff),
            ).fetchall()
            events = self._conn.execute(
                """SELECT * FROM task_events
                   WHERE change_sequence > ? AND change_sequence <= ?
                   ORDER BY change_sequence ASC""",
                (after_sequence, cutoff),
            ).fetchall()
            inbound_rows = self._conn.execute(
                """SELECT * FROM inbound_messages
                   WHERE change_sequence > ? AND change_sequence <= ?
                   ORDER BY change_sequence ASC""",
                (after_sequence, cutoff),
            ).fetchall()
            return {
                "afterSequence": after_sequence,
                "nextSequence": cutoff,
                "items": [self._message_from_row(row) for row in messages],
                "taskEvents": [self._task_event_from_row(row) for row in events],
                "inbound": [json.loads(row["payload_json"]) for row in inbound_rows],
            }

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
        if not isinstance(decision_id, str) or not decision_id:
            raise ValueError("decisionId must be a non-empty string")
        if state not in DECISION_STATES:
            raise ValueError(f"invalid decision state: {state}")
        with self._transaction():
            row = self._require_message_locked(message_id)
            historical = self._conn.execute(
                "SELECT message_id FROM outbound_decisions WHERE decision_id = ?",
                (decision_id,),
            ).fetchone()
            if historical is not None:
                if historical["message_id"] == message_id:
                    return self._message_from_row(row)
                raise ValueError("decision id conflict")
            if row["content_sha256"] != expected_content_sha256:
                raise ValueError("content hash conflict")
            if row["state"] in TERMINAL_STATES:
                raise ValueError(f"message is already terminal: {row['state']}")
            content = row["content"] if optimized_content is None else optimized_content
            content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
            now = _utc_now()
            last_error = reason if state == "policy_error" else None
            self._conn.execute(
                """UPDATE outbound_messages
                   SET state = ?, available_at = ?, content = ?, content_sha256 = ?,
                       transform_trace_json = ?, policy_version = ?, decision_id = ?,
                       last_error = ?, updated_at = ?
                   WHERE message_id = ?""",
                (
                    state,
                    available_at,
                    content,
                    content_hash,
                    _canonical_json(transform_trace),
                    policy_version,
                    decision_id,
                    last_error,
                    now,
                    message_id,
                ),
            )
            self._conn.execute(
                """INSERT INTO outbound_decisions(decision_id, message_id, applied_at)
                   VALUES (?, ?, ?)""",
                (decision_id, message_id, now),
            )
            return self._message_from_row(self._require_message_locked(message_id))

    def next_ready(self, now: str) -> dict[str, Any] | None:
        with self._lock:
            self._ensure_open()
            row = self._conn.execute(
                """SELECT * FROM outbound_messages
                   WHERE state = 'ready' AND (available_at IS NULL OR available_at <= ?)
                   ORDER BY sequence ASC LIMIT 1""",
                (now,),
            ).fetchone()
            return None if row is None else self._message_from_row(row)

    def begin_delivery(
        self,
        message_id: str,
        attempt_id: str,
        expected_content_sha256: str,
        *,
        allow_captured: bool = False,
    ) -> dict[str, Any]:
        with self._transaction():
            row = self._require_message_locked(message_id)
            if row["content_sha256"] != expected_content_sha256:
                raise ValueError("content hash conflict")
            if row["state"] == "delivered":
                return {"deduped": True, "message": self._message_from_row(row)}
            allowed_states = {"ready", "retry_wait"}
            if allow_captured:
                allowed_states.add("captured")
            if row["state"] not in allowed_states:
                raise ValueError(f"message is not deliverable from state {row['state']}")
            existing_attempt = self._conn.execute(
                "SELECT * FROM delivery_attempts WHERE attempt_id = ?", (attempt_id,)
            ).fetchone()
            if existing_attempt is not None:
                if existing_attempt["message_id"] != message_id:
                    raise ValueError("attemptId already belongs to another message")
                return {"deduped": True, "message": self._message_from_row(row)}
            now = _utc_now()
            self._conn.execute(
                """INSERT INTO delivery_attempts(attempt_id, message_id, started_at)
                   VALUES (?, ?, ?)""",
                (attempt_id, message_id, now),
            )
            self._conn.execute(
                """UPDATE outbound_messages
                   SET state = 'delivering', active_attempt_id = ?,
                       attempt_count = attempt_count + 1, last_error = NULL, updated_at = ?
                   WHERE message_id = ?""",
                (attempt_id, now, message_id),
            )
            return {
                "deduped": False,
                "message": self._message_from_row(self._require_message_locked(message_id)),
            }

    def finish_delivery(
        self, message_id: str, attempt_id: str, provider_message_id: str | None
    ) -> dict[str, Any]:
        with self._transaction():
            row = self._require_active_attempt_locked(message_id, attempt_id)
            now = _utc_now()
            self._conn.execute(
                """UPDATE delivery_attempts
                   SET finished_at = ?, outcome = 'delivered', error = NULL
                   WHERE attempt_id = ?""",
                (now, attempt_id),
            )
            self._conn.execute(
                """UPDATE outbound_messages
                   SET state = 'delivered', active_attempt_id = NULL,
                       provider_message_id = ?, delivered_at = ?, updated_at = ?, last_error = NULL
                   WHERE message_id = ?""",
                (provider_message_id, now, now, message_id),
            )
            return self._message_from_row(self._require_message_locked(row["message_id"]))

    def mark_retry(self, message_id: str, attempt_id: str, error: str) -> dict[str, Any]:
        return self._finish_failed_attempt(message_id, attempt_id, "retry_wait", "retry", error)

    def mark_unknown(self, message_id: str, attempt_id: str, error: str) -> dict[str, Any]:
        return self._finish_failed_attempt(
            message_id, attempt_id, "delivery_unknown", "unknown", error
        )

    def update_pending_content(self, message_id: str, content: str) -> dict[str, Any]:
        """Replace a synthetic message before delivery and force policy re-evaluation."""

        if not isinstance(content, str) or not content:
            raise ValueError("content must be a non-empty string")
        with self._transaction():
            row = self._require_message_locked(message_id)
            if row["state"] in TERMINAL_STATES | {"delivering", "delivery_unknown"}:
                raise ValueError(f"message content cannot be changed from state {row['state']}")
            sequence = self._next_sequence_locked()
            content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
            now = _utc_now()
            self._conn.execute(
                """UPDATE outbound_messages
                   SET sequence = ?, content = ?, content_sha256 = ?, state = 'captured',
                       available_at = NULL, policy_version = NULL,
                       transform_trace_json = '[]', last_error = NULL, updated_at = ?
                   WHERE message_id = ?""",
                (sequence, content, content_hash, now, message_id),
            )
            return self._message_from_row(self._require_message_locked(message_id))

    def _finish_failed_attempt(
        self, message_id: str, attempt_id: str, state: str, outcome: str, error: str
    ) -> dict[str, Any]:
        with self._transaction():
            self._require_active_attempt_locked(message_id, attempt_id)
            now = _utc_now()
            self._conn.execute(
                """UPDATE delivery_attempts
                   SET finished_at = ?, outcome = ?, error = ? WHERE attempt_id = ?""",
                (now, outcome, error, attempt_id),
            )
            self._conn.execute(
                """UPDATE outbound_messages
                   SET state = ?, active_attempt_id = NULL, last_error = ?,
                       available_at = ?, updated_at = ? WHERE message_id = ?""",
                (state, error, now if state == "retry_wait" else None, now, message_id),
            )
            return self._message_from_row(self._require_message_locked(message_id))

    def record_task_event(self, event: Mapping[str, Any]) -> dict[str, Any]:
        run_id = _read_required_string(event, "runId")
        session_id = _read_required_string(event, "sessionId")
        kind = _read_required_string(event, "kind")
        occurred_at = _read_required_string(event, "occurredAt")
        event_sequence = event.get("sequence")
        if not isinstance(event_sequence, int) or event_sequence < 0:
            raise ValueError("sequence must be a non-negative integer")
        with self._transaction():
            existing = self._conn.execute(
                "SELECT * FROM task_events WHERE run_id = ? AND event_sequence = ?",
                (run_id, event_sequence),
            ).fetchone()
            if existing is not None:
                return {"deduped": True, "event": self._task_event_from_row(existing)}
            change_sequence = self._next_sequence_locked()
            self._conn.execute(
                """INSERT INTO task_events(
                     run_id, event_sequence, session_id, kind, summary, eta_sec,
                     occurred_at, change_sequence
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    run_id,
                    event_sequence,
                    session_id,
                    kind,
                    event.get("summary"),
                    event.get("etaSec"),
                    occurred_at,
                    change_sequence,
                ),
            )
            row = self._conn.execute(
                "SELECT * FROM task_events WHERE run_id = ? AND event_sequence = ?",
                (run_id, event_sequence),
            ).fetchone()
            assert row is not None
            return {"deduped": False, "event": self._task_event_from_row(row)}

    def record_inbound(self, envelope: Mapping[str, Any]) -> dict[str, Any]:
        inbound_id = _read_required_string(envelope, "inboundMessageId")
        received_at = _read_required_string(envelope, "receivedAt")
        payload_json = _canonical_json(dict(envelope))
        with self._transaction():
            existing = self._conn.execute(
                "SELECT * FROM inbound_messages WHERE inbound_message_id = ?", (inbound_id,)
            ).fetchone()
            if existing is not None:
                if existing["payload_json"] != payload_json:
                    raise ValueError("inboundMessageId already exists with different payload")
                return {"deduped": True, "inbound": json.loads(existing["payload_json"])}
            change_sequence = self._next_sequence_locked()
            self._conn.execute(
                """INSERT INTO inbound_messages(
                     inbound_message_id, payload_json, change_sequence, received_at
                   ) VALUES (?, ?, ?, ?)""",
                (inbound_id, payload_json, change_sequence, received_at),
            )
            return {"deduped": False, "inbound": dict(envelope)}

    def apply_inbound_decision(
        self, inbound_message_id: str, decision: Mapping[str, Any]
    ) -> dict[str, Any]:
        with self._transaction():
            inbound = self._conn.execute(
                "SELECT payload_json FROM inbound_messages WHERE inbound_message_id = ?",
                (inbound_message_id,),
            ).fetchone()
            if inbound is None:
                raise KeyError(inbound_message_id)
            payload = dict(decision)
            if payload.get("inboundMessageId") != inbound_message_id:
                raise ValueError("inboundMessageId does not match route")
            if payload.get("action") not in {"forward", "consume-command"}:
                raise ValueError("invalid inbound action")
            if not isinstance(payload.get("optimizedText"), str):
                raise ValueError("optimizedText must be a string")
            trace = payload.get("transformTrace")
            if not isinstance(trace, list) or not all(isinstance(item, str) for item in trace):
                raise ValueError("transformTrace must be a string array")
            decided_at = _utc_now()
            self._conn.execute(
                """INSERT INTO inbound_decisions(inbound_message_id, decision_json, decided_at)
                   VALUES (?, ?, ?)
                   ON CONFLICT(inbound_message_id) DO UPDATE SET
                     decision_json = excluded.decision_json,
                     decided_at = excluded.decided_at""",
                (inbound_message_id, _canonical_json(payload), decided_at),
            )
            return payload

    def set_policy_snapshot(
        self, version: str, sha256: str, payload: Mapping[str, Any]
    ) -> None:
        if not version or not sha256:
            raise ValueError("policy snapshot version and sha256 are required")
        payload_json = _canonical_json(dict(payload))
        actual_hash = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
        if actual_hash != sha256:
            raise ValueError("policy snapshot hash does not match payload")
        with self._transaction():
            for key, value in (
                ("policy_version", version),
                ("policy_sha256", sha256),
                ("policy_payload", payload_json),
            ):
                self._conn.execute(
                    """INSERT INTO bridge_meta(key, value) VALUES (?, ?)
                       ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
                    (key, value),
                )

    def get_policy_snapshot(self) -> dict[str, Any] | None:
        with self._lock:
            self._ensure_open()
            rows = self._conn.execute(
                "SELECT key, value FROM bridge_meta WHERE key IN (?, ?, ?)",
                ("policy_version", "policy_sha256", "policy_payload"),
            ).fetchall()
            values = {row["key"]: row["value"] for row in rows}
            if set(values) != {"policy_version", "policy_sha256", "policy_payload"}:
                return None
            try:
                payload = json.loads(values["policy_payload"])
            except (TypeError, json.JSONDecodeError):
                return None
            if not isinstance(payload, dict):
                return None
            return {
                "version": values["policy_version"],
                "sha256": values["policy_sha256"],
                "payload": payload,
            }

    def _require_message_locked(self, message_id: str) -> sqlite3.Row:
        row = self._conn.execute(
            "SELECT * FROM outbound_messages WHERE message_id = ?", (message_id,)
        ).fetchone()
        if row is None:
            raise KeyError(message_id)
        return row

    def _require_active_attempt_locked(
        self, message_id: str, attempt_id: str
    ) -> sqlite3.Row:
        row = self._require_message_locked(message_id)
        if row["state"] != "delivering" or row["active_attempt_id"] != attempt_id:
            raise ValueError("attempt is not active for this message")
        return row

    @staticmethod
    def _message_from_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "messageId": row["message_id"],
            "sequence": int(row["sequence"]),
            "instanceId": row["instance_id"],
            "adapterId": row["adapter_id"],
            "channel": row["channel"],
            "accountId": row["account_id"],
            "chatId": row["chat_id"],
            "threadId": row["thread_id"],
            "sessionId": row["session_id"],
            "runId": row["run_id"],
            "inboundMessageId": row["inbound_message_id"],
            "messageKind": row["message_kind"],
            "transport": row["transport"],
            "priority": row["priority"],
            "content": row["content"],
            "contentSha256": row["content_sha256"],
            "replyTo": row["reply_to"],
            "metadata": json.loads(row["metadata_json"]),
            "state": row["state"],
            "availableAt": row["available_at"],
            "attemptCount": int(row["attempt_count"]),
            "providerMessageId": row["provider_message_id"],
            "policyVersion": row["policy_version"],
            "transformTrace": json.loads(row["transform_trace_json"]),
            "lastError": row["last_error"],
            "capturedAt": row["captured_at"],
            "updatedAt": row["updated_at"],
            "deliveredAt": row["delivered_at"],
        }

    @staticmethod
    def _task_event_from_row(row: sqlite3.Row) -> dict[str, Any]:
        event = {
            "runId": row["run_id"],
            "sequence": int(row["event_sequence"]),
            "sessionId": row["session_id"],
            "kind": row["kind"],
            "occurredAt": row["occurred_at"],
        }
        if row["summary"] is not None:
            event["summary"] = row["summary"]
        if row["eta_sec"] is not None:
            event["etaSec"] = int(row["eta_sec"])
        return event
