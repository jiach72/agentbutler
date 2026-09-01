"""Crash-safe SQLite Outbox for the Hermes-side Butler Bridge."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Mapping

from .ids import uuid7


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
MESSAGE_HISTORY_RETENTION_DAYS = 7
HISTORY_PRUNE_STATES = TERMINAL_STATES | {"delivery_unknown", "policy_error"}
TASK_EVENT_KINDS = {"started", "progress", "completing", "done", "failed"}
TASK_TERMINAL_STATES = {"done", "failed"}
CONVERSATION_REPLY_KINDS = {"final", "failure", "task-progress"}
DEAD_LETTER_SOURCE_STATES = {
    "captured",
    "policy_pending",
    "held_dnd",
    "held_pacing",
    "ready",
    "retry_wait",
    "policy_error",
}
MAX_CONTENT_BYTES = 1024 * 1024
MAX_METADATA_BYTES = 256 * 1024
MAX_ATTACHMENTS = 32

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
  delivery_route_json TEXT,
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
  event_key TEXT,
  summary TEXT,
  eta_sec INTEGER,
  occurred_at TEXT NOT NULL,
  change_sequence INTEGER NOT NULL UNIQUE,
  PRIMARY KEY (run_id, event_sequence)
);

CREATE TABLE IF NOT EXISTS task_runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  inbound_message_id TEXT REFERENCES inbound_messages(inbound_message_id),
  supersedes_run_id TEXT,
  state TEXT NOT NULL,
  next_event_sequence INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_runs_inbound
  ON task_runs(inbound_message_id, started_at);

CREATE TABLE IF NOT EXISTS inbound_messages (
  inbound_message_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  change_sequence INTEGER NOT NULL UNIQUE,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_heads (
  instance_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  inbound_message_id TEXT NOT NULL REFERENCES inbound_messages(inbound_message_id),
  received_at TEXT NOT NULL,
  change_sequence INTEGER NOT NULL,
  PRIMARY KEY (instance_id, channel, chat_id, thread_key)
);

CREATE TABLE IF NOT EXISTS inbound_decisions (
  inbound_message_id TEXT PRIMARY KEY REFERENCES inbound_messages(inbound_message_id),
  decision_json TEXT NOT NULL,
  decided_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_attachments (
  attachment_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES outbound_messages(message_id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  spool_path TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_attachments_message
  ON message_attachments(message_id, attachment_id);

CREATE TABLE IF NOT EXISTS message_state_events (
  event_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES outbound_messages(message_id),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_state_events_message
  ON message_state_events(message_id, occurred_at, event_id);
"""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                return digest.hexdigest()
            digest.update(chunk)


def _read_required_string(payload: Mapping[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key} must be a non-empty string")
    return value


def _parse_utc_timestamp(value: str, field: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError(f"{field} must be a UTC ISO timestamp")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise ValueError(f"{field} must be a UTC ISO timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        raise ValueError(f"{field} must be a UTC ISO timestamp")
    return parsed


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
            self._migrate_task_events_locked()
            self._backfill_outbound_decisions_locked()
            self._backfill_task_runs_locked()
            self._ensure_sequence_seed_locked()
            self._backfill_conversation_heads_locked()
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
            self._cancel_unlinked_replies_locked()

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
        if "delivery_route_json" not in columns:
            self._conn.execute("ALTER TABLE outbound_messages ADD COLUMN delivery_route_json TEXT")
        self._conn.execute(
            """CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_decision_id
               ON outbound_messages(decision_id)
               WHERE decision_id IS NOT NULL"""
        )

    def _migrate_task_events_locked(self) -> None:
        columns = {
            row["name"]
            for row in self._conn.execute("PRAGMA table_info(task_events)").fetchall()
        }
        if "event_key" not in columns:
            self._conn.execute("ALTER TABLE task_events ADD COLUMN event_key TEXT")
        self._conn.execute(
            """CREATE UNIQUE INDEX IF NOT EXISTS idx_task_event_key
               ON task_events(run_id, event_key)
               WHERE event_key IS NOT NULL"""
        )

    def _backfill_outbound_decisions_locked(self) -> None:
        self._conn.execute(
            """INSERT OR IGNORE INTO outbound_decisions(decision_id, message_id, applied_at)
               SELECT decision_id, message_id, updated_at
               FROM outbound_messages
               WHERE decision_id IS NOT NULL"""
        )

    def _backfill_task_runs_locked(self) -> None:
        rows = self._conn.execute(
            """SELECT run_id, MIN(occurred_at) AS started_at,
                      MAX(occurred_at) AS updated_at, MAX(event_sequence) AS max_sequence
               FROM task_events GROUP BY run_id"""
        ).fetchall()
        for row in rows:
            first = self._conn.execute(
                """SELECT session_id FROM task_events
                   WHERE run_id = ? ORDER BY event_sequence ASC LIMIT 1""",
                (row["run_id"],),
            ).fetchone()
            latest = self._conn.execute(
                """SELECT kind, occurred_at FROM task_events
                   WHERE run_id = ? ORDER BY event_sequence DESC LIMIT 1""",
                (row["run_id"],),
            ).fetchone()
            assert first is not None and latest is not None
            completed_at = latest["occurred_at"] if latest["kind"] in TASK_TERMINAL_STATES else None
            self._conn.execute(
                """INSERT OR IGNORE INTO task_runs(
                     run_id, session_id, state, next_event_sequence,
                     started_at, updated_at, completed_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    row["run_id"],
                    first["session_id"],
                    latest["kind"],
                    int(row["max_sequence"]) + 1,
                    row["started_at"],
                    row["updated_at"],
                    completed_at,
                ),
            )

    def _backfill_conversation_heads_locked(self) -> None:
        rows = self._conn.execute(
            """SELECT payload_json, change_sequence, received_at
               FROM inbound_messages ORDER BY change_sequence ASC"""
        ).fetchall()
        for row in rows:
            payload = json.loads(row["payload_json"])
            self._update_conversation_head_locked(
                payload,
                int(row["change_sequence"]),
                str(row["received_at"]),
            )
        heads = self._conn.execute(
            """SELECT m.payload_json
               FROM conversation_heads h
               JOIN inbound_messages m
                 ON m.inbound_message_id = h.inbound_message_id"""
        ).fetchall()
        for row in heads:
            self._cancel_superseded_messages_locked(json.loads(row["payload_json"]))

    def _update_conversation_head_locked(
        self,
        envelope: Mapping[str, Any],
        change_sequence: int,
        received_at: str,
    ) -> bool:
        instance_id = _read_required_string(envelope, "instanceId")
        channel = _read_required_string(envelope, "channel")
        chat_id = _read_required_string(envelope, "chatId")
        inbound_id = _read_required_string(envelope, "inboundMessageId")
        thread_key = str(envelope.get("threadId") or "")
        self._conn.execute(
            """INSERT INTO conversation_heads(
                 instance_id, channel, chat_id, thread_key, inbound_message_id,
                 received_at, change_sequence
               ) VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(instance_id, channel, chat_id, thread_key) DO UPDATE SET
                 inbound_message_id = excluded.inbound_message_id,
                 received_at = excluded.received_at,
                 change_sequence = excluded.change_sequence
               WHERE excluded.received_at > conversation_heads.received_at
                  OR (excluded.received_at = conversation_heads.received_at
                      AND excluded.change_sequence > conversation_heads.change_sequence)""",
            (
                instance_id,
                channel,
                chat_id,
                thread_key,
                inbound_id,
                received_at,
                change_sequence,
            ),
        )
        head = self._conn.execute(
            """SELECT inbound_message_id FROM conversation_heads
               WHERE instance_id = ? AND channel = ? AND chat_id = ? AND thread_key = ?""",
            (instance_id, channel, chat_id, thread_key),
        ).fetchone()
        return head is not None and head["inbound_message_id"] == inbound_id

    def _stale_conversation_reason_locked(
        self, envelope: Mapping[str, Any]
    ) -> str | None:
        inbound_id = envelope.get("inboundMessageId")
        if (
            envelope.get("transport") != "queued-push"
            # A normal follow-up message does not supersede a prior question's
            # terminal answer. Only progress is safe to discard by conversation
            # head; terminal replies remain deliverable unless a run explicitly
            # declares that it supersedes another run.
            or envelope.get("messageKind") != "task-progress"
            or not isinstance(inbound_id, str)
            or not inbound_id
        ):
            return None
        head = self._conn.execute(
            """SELECT inbound_message_id FROM conversation_heads
               WHERE instance_id = ? AND channel = ? AND chat_id = ? AND thread_key = ?""",
            (
                envelope.get("instanceId"),
                envelope.get("channel"),
                envelope.get("chatId"),
                str(envelope.get("threadId") or ""),
            ),
        ).fetchone()
        if head is None or head["inbound_message_id"] == inbound_id:
            return None
        return f"superseded by newer inbound {head['inbound_message_id']}"

    @staticmethod
    def _unlinked_reply_reason(envelope: Mapping[str, Any]) -> str | None:
        if (
            envelope.get("transport") != "queued-push"
            or envelope.get("messageKind") not in CONVERSATION_REPLY_KINDS
        ):
            return None
        inbound_id = envelope.get("inboundMessageId")
        if isinstance(inbound_id, str) and inbound_id:
            return None
        metadata = envelope.get("metadata")
        if isinstance(metadata, Mapping) and metadata.get("proactive") is True:
            return None
        return "missing inbound correlation for queued reply"

    def _cancel_unlinked_replies_locked(self) -> None:
        rows = self._conn.execute(
            """SELECT message_id, state, metadata_json
               FROM outbound_messages
               WHERE inbound_message_id IS NULL
                 AND transport = 'queued-push'
                 AND message_kind IN ('final', 'failure', 'task-progress')
                 AND state IN (
                   'captured', 'policy_pending', 'held_dnd', 'held_pacing',
                   'ready', 'retry_wait', 'policy_error', 'delivery_unknown'
                 )"""
        ).fetchall()
        now = _utc_now()
        reason = "missing inbound correlation for queued reply"
        for row in rows:
            try:
                metadata = json.loads(row["metadata_json"])
            except (TypeError, ValueError):
                metadata = {}
            if isinstance(metadata, Mapping) and metadata.get("proactive") is True:
                continue
            sequence = self._next_sequence_locked()
            self._conn.execute(
                """UPDATE outbound_messages
                   SET sequence = ?, state = 'cancelled', active_attempt_id = NULL,
                       available_at = NULL, last_error = ?, updated_at = ?
                   WHERE message_id = ?""",
                (sequence, reason, now, row["message_id"]),
            )
            self._conn.execute(
                """INSERT INTO message_state_events(
                     event_id, message_id, from_state, to_state, reason, occurred_at
                   ) VALUES (?, ?, ?, 'cancelled', ?, ?)""",
                (uuid7(), row["message_id"], row["state"], reason, now),
            )

    def _cancel_superseded_messages_locked(
        self, envelope: Mapping[str, Any]
    ) -> None:
        inbound_id = _read_required_string(envelope, "inboundMessageId")
        rows = self._conn.execute(
            """SELECT message_id, state FROM outbound_messages
               WHERE instance_id = ? AND channel = ? AND chat_id = ?
                 AND COALESCE(thread_id, '') = ?
                 AND inbound_message_id IS NOT NULL AND inbound_message_id <> ?
                 AND transport = 'queued-push'
                 AND message_kind = 'task-progress'
                 AND state IN (
                   'captured', 'policy_pending', 'held_dnd', 'held_pacing',
                   'ready', 'retry_wait', 'policy_error', 'delivery_unknown'
                  )""",
            (
                envelope.get("instanceId"),
                envelope.get("channel"),
                envelope.get("chatId"),
                str(envelope.get("threadId") or ""),
                inbound_id,
            ),
        ).fetchall()
        if not rows:
            return
        now = _utc_now()
        reason = f"superseded by newer inbound {inbound_id}"
        for row in rows:
            sequence = self._next_sequence_locked()
            self._conn.execute(
                """UPDATE outbound_messages
                   SET sequence = ?, state = 'cancelled', active_attempt_id = NULL,
                       available_at = NULL, last_error = ?, updated_at = ?
                   WHERE message_id = ?""",
                (sequence, reason, now, row["message_id"]),
            )
            self._conn.execute(
                """INSERT INTO message_state_events(
                     event_id, message_id, from_state, to_state, reason, occurred_at
                   ) VALUES (?, ?, ?, 'cancelled', ?, ?)""",
                (uuid7(), row["message_id"], row["state"], reason, now),
            )

    def _cancel_superseded_run_messages_locked(
        self, superseded_run_id: str, replacing_run_id: str
    ) -> None:
        """Cancel pending replies only when a run explicitly replaces another run."""

        rows = self._conn.execute(
            """SELECT message_id, state FROM outbound_messages
               WHERE run_id = ?
                 AND message_kind IN ('final', 'failure', 'task-progress')
                 AND state IN (
                   'captured', 'policy_pending', 'held_dnd', 'held_pacing',
                   'ready', 'retry_wait', 'policy_error', 'delivery_unknown'
                 )""",
            (superseded_run_id,),
        ).fetchall()
        if not rows:
            return
        now = _utc_now()
        reason = f"superseded by explicit run {replacing_run_id}"
        for row in rows:
            sequence = self._next_sequence_locked()
            self._conn.execute(
                """UPDATE outbound_messages
                   SET sequence = ?, state = 'cancelled', active_attempt_id = NULL,
                       available_at = NULL, last_error = ?, updated_at = ?
                   WHERE message_id = ?""",
                (sequence, reason, now, row["message_id"]),
            )
            self._conn.execute(
                """INSERT INTO message_state_events(
                     event_id, message_id, from_state, to_state, reason, occurred_at
                   ) VALUES (?, ?, ?, 'cancelled', ?, ?)""",
                (uuid7(), row["message_id"], row["state"], reason, now),
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
        if len(content.encode("utf-8")) > MAX_CONTENT_BYTES:
            raise ValueError("content exceeds maximum size")
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
        if len(metadata_json.encode("utf-8")) > MAX_METADATA_BYTES:
            raise ValueError("metadata exceeds maximum size")
        attachments = self._validate_attachments(envelope.get("attachments", []))
        delivery_route = self._validate_delivery_route(envelope.get("deliveryRoute"))
        delivery_route_json = (
            None if delivery_route is None else _canonical_json(delivery_route)
        )
        if (
            delivery_route_json is not None
            and len(delivery_route_json.encode("utf-8")) > MAX_METADATA_BYTES
        ):
            raise ValueError("deliveryRoute exceeds maximum size")

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
            stale_reason = self._unlinked_reply_reason(envelope)
            if stale_reason is None:
                stale_reason = self._stale_conversation_reason_locked(envelope)
            initial_state = "cancelled" if stale_reason is not None else "captured"
            self._conn.execute(
                """INSERT INTO outbound_messages (
                     message_id, sequence, instance_id, adapter_id, channel, account_id,
                     chat_id, thread_id, session_id, run_id, inbound_message_id,
                     message_kind, transport, priority, content, content_sha256,
                     reply_to, metadata_json, delivery_route_json, state,
                     captured_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                             ?, ?, ?)""",
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
                    delivery_route_json,
                    initial_state,
                    required["capturedAt"],
                    now,
                ),
            )
            if stale_reason is not None:
                self._conn.execute(
                    """UPDATE outbound_messages SET last_error = ? WHERE message_id = ?""",
                    (stale_reason, message_id),
                )
                self._conn.execute(
                    """INSERT INTO message_state_events(
                         event_id, message_id, from_state, to_state, reason, occurred_at
                       ) VALUES (?, ?, 'captured', 'cancelled', ?, ?)""",
                    (uuid7(), message_id, stale_reason, now),
                )
            for attachment in attachments:
                self._conn.execute(
                    """INSERT INTO message_attachments(
                         attachment_id, message_id, file_name, mime_type, size_bytes,
                         sha256, spool_path, state, created_at
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'spooled', ?)""",
                    (
                        attachment["attachmentId"],
                        message_id,
                        attachment["fileName"],
                        attachment["mimeType"],
                        attachment["sizeBytes"],
                        attachment["sha256"],
                        attachment["spoolPath"],
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

    def get_delivery(self, message_id: str) -> dict[str, Any] | None:
        with self._lock:
            self._ensure_open()
            row = self._conn.execute(
                "SELECT * FROM outbound_messages WHERE message_id = ?", (message_id,)
            ).fetchone()
            if row is None:
                return None
            view = self._message_from_row(row)
            raw_route = row["delivery_route_json"]
            view["_deliveryRoute"] = None if raw_route is None else json.loads(raw_route)
            view["_attachments"] = self.attachments_for(message_id, include_paths=True)
            return view

    def attachments_for(
        self, message_id: str, *, include_paths: bool = False
    ) -> list[dict[str, Any]]:
        with self._lock:
            self._ensure_open()
            rows = self._conn.execute(
                """SELECT * FROM message_attachments
                   WHERE message_id = ? ORDER BY attachment_id""",
                (message_id,),
            ).fetchall()
            attachments: list[dict[str, Any]] = []
            for row in rows:
                item = {
                    "attachmentId": row["attachment_id"],
                    "fileName": row["file_name"],
                    "mimeType": row["mime_type"],
                    "sizeBytes": int(row["size_bytes"]),
                    "sha256": row["sha256"],
                    "state": row["state"],
                }
                if include_paths:
                    item["spoolPath"] = row["spool_path"]
                attachments.append(item)
            return attachments

    @staticmethod
    def _validate_attachments(value: Any) -> list[dict[str, Any]]:
        if value is None:
            return []
        if not isinstance(value, list):
            raise ValueError("attachments must be an array")
        if len(value) > MAX_ATTACHMENTS:
            raise ValueError("attachment count exceeds limit")
        validated: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        for raw in value:
            if not isinstance(raw, Mapping):
                raise ValueError("attachment must be an object")
            attachment_id = _read_required_string(raw, "attachmentId")
            file_name = _read_required_string(raw, "fileName")
            mime_type = _read_required_string(raw, "mimeType")
            sha256 = _read_required_string(raw, "sha256")
            spool_path = _read_required_string(raw, "spoolPath")
            size = raw.get("sizeBytes")
            if not isinstance(size, int) or size < 0:
                raise ValueError("attachment sizeBytes must be a non-negative integer")
            if attachment_id in seen_ids:
                raise ValueError("duplicate attachmentId")
            if len(sha256) != 64 or any(character not in "0123456789abcdef" for character in sha256):
                raise ValueError("attachment sha256 must be lowercase hexadecimal")
            path = Path(spool_path)
            if path.is_symlink() or not path.is_file():
                raise ValueError("attachment spoolPath must be a regular file")
            if path.stat().st_size != size:
                raise ValueError("attachment size does not match spool file")
            if _sha256_file(path) != sha256:
                raise ValueError("attachment sha256 does not match spool file")
            seen_ids.add(attachment_id)
            validated.append(
                {
                    "attachmentId": attachment_id,
                    "fileName": file_name,
                    "mimeType": mime_type,
                    "sizeBytes": size,
                    "sha256": sha256,
                    "spoolPath": spool_path,
                }
            )
        return validated

    @staticmethod
    def _validate_delivery_route(value: Any) -> dict[str, Any] | None:
        if value is None:
            return None
        if not isinstance(value, Mapping):
            raise ValueError("deliveryRoute must be an object")
        route = dict(value)
        if route.get("kind") != "media":
            raise ValueError("unsupported deliveryRoute kind")
        method = route.get("method")
        local_methods = {
            "send_image_file",
            "send_document",
            "send_video",
            "send_voice",
        }
        if method in {"send_image", "send_animation"}:
            source = route.get("source")
            if not isinstance(source, str) or not source:
                raise ValueError("deliveryRoute source must be a non-empty string")
            has_caption = route.get("hasCaption")
            if not isinstance(has_caption, bool):
                raise ValueError("deliveryRoute hasCaption must be boolean")
            return {
                "kind": "media",
                "method": method,
                "source": source,
                "hasCaption": has_caption,
            }
        if method == "send_multiple_images":
            raw_images = route.get("images")
            if not isinstance(raw_images, list) or not raw_images:
                raise ValueError("deliveryRoute images must be a non-empty array")
            if len(raw_images) > MAX_ATTACHMENTS:
                raise ValueError("deliveryRoute images exceed maximum count")
            images: list[dict[str, str]] = []
            for item in raw_images:
                if not isinstance(item, Mapping):
                    raise ValueError("deliveryRoute image must be an object")
                source = item.get("source")
                caption = item.get("caption")
                if not isinstance(source, str) or not source:
                    raise ValueError("deliveryRoute image source must be non-empty")
                if not isinstance(caption, str):
                    raise ValueError("deliveryRoute image caption must be a string")
                images.append({"source": source, "caption": caption})
            human_delay = route.get("humanDelay", 0.0)
            if (
                isinstance(human_delay, bool)
                or not isinstance(human_delay, (int, float))
                or not 0 <= float(human_delay) <= 3600
            ):
                raise ValueError("deliveryRoute humanDelay must be between 0 and 3600")
            return {
                "kind": "media",
                "method": method,
                "images": images,
                "humanDelay": float(human_delay),
            }
        if method not in local_methods:
            raise ValueError("unsupported media delivery method")
        attachment_id = route.get("attachmentId")
        if not isinstance(attachment_id, str) or not attachment_id:
            raise ValueError("deliveryRoute attachmentId must be a non-empty string")
        has_caption = route.get("hasCaption")
        if not isinstance(has_caption, bool):
            raise ValueError("deliveryRoute hasCaption must be boolean")
        file_name = route.get("fileName")
        if file_name is not None and (not isinstance(file_name, str) or not file_name):
            raise ValueError("deliveryRoute fileName must be a non-empty string or null")
        return {
            "kind": "media",
            "method": method,
            "attachmentId": attachment_id,
            "hasCaption": has_caption,
            "fileName": file_name,
        }

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

    def prune_history(self, cutoff: str | None = None) -> int:
        """Delete only old terminal outbound traces and their dependent rows."""
        cutoff_value = cutoff or (
            datetime.now(timezone.utc) - timedelta(days=MESSAGE_HISTORY_RETENTION_DAYS)
        ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        _parse_utc_timestamp(cutoff_value, "cutoff")
        placeholders = ",".join("?" for _ in HISTORY_PRUNE_STATES)
        states = tuple(sorted(HISTORY_PRUNE_STATES))
        spool_paths: list[Path] = []
        with self._transaction():
            rows = self._conn.execute(
                f"SELECT message_id FROM outbound_messages WHERE updated_at < ? AND state IN ({placeholders})",
                (cutoff_value, *states),
            ).fetchall()
            message_ids = [str(row["message_id"]) for row in rows]
            if not message_ids:
                return 0

            message_placeholders = ",".join("?" for _ in message_ids)
            for row in self._conn.execute(
                f"SELECT spool_path FROM message_attachments WHERE message_id IN ({message_placeholders})",
                message_ids,
            ).fetchall():
                if row["spool_path"]:
                    spool_paths.append(Path(str(row["spool_path"])))

            self._conn.execute(
                f"DELETE FROM outbound_decisions WHERE message_id IN ({message_placeholders})",
                message_ids,
            )
            self._conn.execute(
                f"DELETE FROM delivery_attempts WHERE message_id IN ({message_placeholders})",
                message_ids,
            )
            self._conn.execute(
                f"DELETE FROM message_attachments WHERE message_id IN ({message_placeholders})",
                message_ids,
            )
            self._conn.execute(
                f"DELETE FROM message_state_events WHERE message_id IN ({message_placeholders})",
                message_ids,
            )
            self._conn.execute(
                f"DELETE FROM outbound_messages WHERE message_id IN ({message_placeholders})",
                message_ids,
            )

        for spool_path in spool_paths:
            try:
                spool_path.unlink(missing_ok=True)
            except OSError:
                # The DB record is already gone; an orphaned spool is harmless and can be
                # swept by the private spool maintenance pass without blocking delivery.
                continue
        return len(message_ids)

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
                if historical["message_id"] != message_id:
                    raise ValueError("decision id conflict")
                # True replay: this exact decision is already the row's current state,
                # or the message has reached a terminal state -> return the row as-is.
                if row["state"] in TERMINAL_STATES or row["state"] == "delivering" or (
                    row["decision_id"] == decision_id and row["state"] == state
                ):
                    return self._message_from_row(row)
                # Otherwise the row moved on after this decision was first applied
                # (e.g. ready -> held_pacing -> ready). The gateway re-issues the same
                # semantic decision, so re-apply it instead of returning the stale row.
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
                   VALUES (?, ?, ?)
                   ON CONFLICT(decision_id) DO UPDATE SET applied_at = excluded.applied_at""",
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

    def pending_run_results(self, run_id: str) -> list[dict[str, Any]]:
        """Return non-terminal final/failure messages for a task in capture order."""

        if not isinstance(run_id, str) or not run_id:
            raise ValueError("run_id must be a non-empty string")
        with self._lock:
            self._ensure_open()
            rows = self._conn.execute(
                """SELECT * FROM outbound_messages
                   WHERE run_id = ?
                     AND message_kind IN ('final', 'failure')
                     AND state NOT IN ('delivered', 'absorbed', 'dead_letter', 'cancelled')
                   ORDER BY sequence ASC""",
                (run_id,),
            ).fetchall()
            return [self._message_from_row(row) for row in rows]

    def has_task_receipt(self, run_id: str) -> bool:
        """Return whether the one-shot acknowledgement for a task was captured."""

        if not isinstance(run_id, str) or not run_id:
            raise ValueError("run_id must be a non-empty string")
        with self._lock:
            self._ensure_open()
            rows = self._conn.execute(
                """SELECT metadata_json FROM outbound_messages
                   WHERE run_id = ? AND message_kind = 'system'""",
                (run_id,),
            ).fetchall()
            for row in rows:
                try:
                    metadata = json.loads(row["metadata_json"])
                except (TypeError, ValueError):
                    continue
                if isinstance(metadata, Mapping) and metadata.get("taskReceipt") is True:
                    return True
            return False

    def finalize_pending_message(
        self,
        message_id: str,
        *,
        content: str | None = None,
        metadata_updates: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Update a captured result before the terminal task event is published."""

        if content is not None and (not isinstance(content, str) or not content):
            raise ValueError("content must be a non-empty string or None")
        if metadata_updates is not None and not isinstance(metadata_updates, Mapping):
            raise ValueError("metadata_updates must be an object or None")
        with self._transaction():
            row = self._require_message_locked(message_id)
            if row["state"] in TERMINAL_STATES | {"delivering", "delivery_unknown"}:
                raise ValueError(f"message cannot be finalized from state {row['state']}")
            current_metadata = json.loads(row["metadata_json"])
            if not isinstance(current_metadata, dict):
                current_metadata = {}
            if metadata_updates:
                current_metadata.update(dict(metadata_updates))
            next_content = row["content"] if content is None else content
            content_hash = hashlib.sha256(next_content.encode("utf-8")).hexdigest()
            sequence = self._next_sequence_locked()
            now = _utc_now()
            self._conn.execute(
                """UPDATE outbound_messages
                   SET sequence = ?, content = ?, content_sha256 = ?, metadata_json = ?,
                       state = 'captured', available_at = NULL, policy_version = NULL,
                       decision_id = NULL, transform_trace_json = '[]', last_error = NULL,
                       updated_at = ?
                   WHERE message_id = ?""",
                (
                    sequence,
                    next_content,
                    content_hash,
                    _canonical_json(current_metadata),
                    now,
                    message_id,
                ),
            )
            return self._message_from_row(self._require_message_locked(message_id))

    def absorb_message(self, message_id: str, reason: str = "duplicate terminal result absorbed") -> dict[str, Any]:
        """Mark a pending duplicate as absorbed without making it deliverable."""

        if not isinstance(reason, str) or not reason.strip():
            raise ValueError("absorb reason must be a non-empty string")
        with self._transaction():
            row = self._require_message_locked(message_id)
            if row["state"] in TERMINAL_STATES:
                return self._message_from_row(row)
            if row["state"] in {"delivering", "delivery_unknown"}:
                raise ValueError(f"message cannot be absorbed from state {row['state']}")
            now = _utc_now()
            self._conn.execute(
                """UPDATE outbound_messages
                   SET state = 'absorbed', active_attempt_id = NULL,
                       available_at = NULL, last_error = ?, updated_at = ?
                   WHERE message_id = ?""",
                (reason.strip(), now, message_id),
            )
            self._conn.execute(
                """INSERT INTO message_state_events(
                     event_id, message_id, from_state, to_state, reason, occurred_at
                   ) VALUES (?, ?, ?, 'absorbed', ?, ?)""",
                (uuid7(), message_id, row["state"], reason.strip(), now),
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

    def begin_run(
        self,
        *,
        session_id: str,
        inbound_message_id: str | None = None,
        run_id: str | None = None,
        supersedes_run_id: str | None = None,
        occurred_at: str | None = None,
    ) -> dict[str, Any]:
        if not isinstance(session_id, str) or not session_id:
            raise ValueError("session_id must be a non-empty string")
        if inbound_message_id is not None and not inbound_message_id:
            raise ValueError("inbound_message_id must be non-empty when provided")
        if supersedes_run_id is not None and not supersedes_run_id:
            raise ValueError("supersedes_run_id must be non-empty when provided")
        selected_run_id = run_id or uuid7()
        if not selected_run_id:
            raise ValueError("run_id must be a non-empty string")
        timestamp = occurred_at or _utc_now()
        with self._transaction():
            existing = self._conn.execute(
                "SELECT * FROM task_runs WHERE run_id = ?", (selected_run_id,)
            ).fetchone()
            if existing is not None:
                if (
                    existing["session_id"] != session_id
                    or existing["inbound_message_id"] != inbound_message_id
                    or existing["supersedes_run_id"] != supersedes_run_id
                ):
                    raise ValueError("runId already exists with different correlation")
                event = self._conn.execute(
                    "SELECT * FROM task_events WHERE run_id = ? AND event_sequence = 1",
                    (selected_run_id,),
                ).fetchone()
                assert event is not None
                return {
                    "deduped": True,
                    "run": self._run_from_row(existing),
                    "event": self._task_event_from_row(event),
                }
            if inbound_message_id is not None:
                inbound = self._conn.execute(
                    "SELECT * FROM inbound_messages WHERE inbound_message_id = ?",
                    (inbound_message_id,),
                ).fetchone()
                if inbound is None:
                    raise KeyError(inbound_message_id)
            if supersedes_run_id is not None:
                superseded = self._conn.execute(
                    "SELECT run_id FROM task_runs WHERE run_id = ?", (supersedes_run_id,)
                ).fetchone()
                if superseded is None:
                    raise KeyError(supersedes_run_id)
            self._conn.execute(
                """INSERT INTO task_runs(
                     run_id, session_id, inbound_message_id, supersedes_run_id,
                     state, next_event_sequence, started_at, updated_at
                   ) VALUES (?, ?, ?, ?, 'started', 2, ?, ?)""",
                (
                    selected_run_id,
                    session_id,
                    inbound_message_id,
                    supersedes_run_id,
                    timestamp,
                    timestamp,
                ),
            )
            change_sequence = self._next_sequence_locked()
            self._conn.execute(
                """INSERT INTO task_events(
                     run_id, event_sequence, session_id, kind, event_key,
                     occurred_at, change_sequence
                   ) VALUES (?, 1, ?, 'started', 'lifecycle:started', ?, ?)""",
                (selected_run_id, session_id, timestamp, change_sequence),
            )
            if inbound_message_id is not None:
                inbound = self._conn.execute(
                    "SELECT payload_json FROM inbound_messages WHERE inbound_message_id = ?",
                    (inbound_message_id,),
                ).fetchone()
                assert inbound is not None
                inbound_payload = json.loads(inbound["payload_json"])
                existing_run = inbound_payload.get("runId")
                if existing_run not in (None, selected_run_id):
                    raise ValueError("inbound message is already bound to another run")
                inbound_payload["runId"] = selected_run_id
                inbound_payload["sessionId"] = session_id
                inbound_change = self._next_sequence_locked()
                self._conn.execute(
                    """UPDATE inbound_messages
                       SET payload_json = ?, change_sequence = ?
                       WHERE inbound_message_id = ?""",
                    (_canonical_json(inbound_payload), inbound_change, inbound_message_id),
                )
            if supersedes_run_id is not None:
                self._cancel_superseded_run_messages_locked(
                    supersedes_run_id, selected_run_id
                )
            run = self._conn.execute(
                "SELECT * FROM task_runs WHERE run_id = ?", (selected_run_id,)
            ).fetchone()
            event = self._conn.execute(
                "SELECT * FROM task_events WHERE run_id = ? AND event_sequence = 1",
                (selected_run_id,),
            ).fetchone()
            assert run is not None and event is not None
            return {
                "deduped": False,
                "run": self._run_from_row(run),
                "event": self._task_event_from_row(event),
            }

    def append_task_event(
        self,
        run_id: str,
        kind: str,
        *,
        summary: str | None = None,
        eta_sec: int | None = None,
        event_key: str | None = None,
        occurred_at: str | None = None,
    ) -> dict[str, Any]:
        if not isinstance(run_id, str) or not run_id:
            raise ValueError("run_id must be a non-empty string")
        if kind not in TASK_EVENT_KINDS or kind == "started":
            raise ValueError("invalid appended task event kind")
        if summary is not None and not isinstance(summary, str):
            raise ValueError("summary must be a string or None")
        if eta_sec is not None and (not isinstance(eta_sec, int) or eta_sec < 0):
            raise ValueError("eta_sec must be a non-negative integer or None")
        if event_key is not None and (not isinstance(event_key, str) or not event_key):
            raise ValueError("event_key must be a non-empty string or None")
        timestamp = occurred_at or _utc_now()
        with self._transaction():
            return self._append_task_event_locked(
                run_id,
                kind,
                summary=summary,
                eta_sec=eta_sec,
                event_key=event_key,
                occurred_at=timestamp,
            )

    def finish_run(
        self,
        run_id: str,
        *,
        failed: bool = False,
        summary: str | None = None,
        occurred_at: str | None = None,
    ) -> dict[str, Any]:
        kind = "failed" if failed else "done"
        return self.append_task_event(
            run_id,
            kind,
            summary=summary,
            event_key=f"lifecycle:{kind}",
            occurred_at=occurred_at,
        )

    def _append_task_event_locked(
        self,
        run_id: str,
        kind: str,
        *,
        summary: str | None,
        eta_sec: int | None,
        event_key: str | None,
        occurred_at: str,
    ) -> dict[str, Any]:
        if event_key is not None:
            replay = self._conn.execute(
                "SELECT * FROM task_events WHERE run_id = ? AND event_key = ?",
                (run_id, event_key),
            ).fetchone()
            if replay is not None:
                expected = self._task_event_from_row(replay)
                if (
                    expected["kind"] != kind
                    or expected.get("summary") != summary
                    or expected.get("etaSec") != eta_sec
                ):
                    raise ValueError("task event key already exists with different payload")
                return {"deduped": True, "event": expected}
        run = self._conn.execute(
            "SELECT * FROM task_runs WHERE run_id = ?", (run_id,)
        ).fetchone()
        if run is None:
            raise KeyError(run_id)
        if run["state"] in TASK_TERMINAL_STATES:
            raise ValueError(f"run is already terminal: {run['state']}")
        if run["state"] == "completing" and kind == "progress":
            raise ValueError("run cannot return to progress after completing")
        event_sequence = int(run["next_event_sequence"])
        change_sequence = self._next_sequence_locked()
        self._conn.execute(
            """INSERT INTO task_events(
                 run_id, event_sequence, session_id, kind, event_key, summary,
                 eta_sec, occurred_at, change_sequence
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                run_id,
                event_sequence,
                run["session_id"],
                kind,
                event_key,
                summary,
                eta_sec,
                occurred_at,
                change_sequence,
            ),
        )
        completed_at = occurred_at if kind in TASK_TERMINAL_STATES else None
        self._conn.execute(
            """UPDATE task_runs
               SET state = ?, next_event_sequence = ?, updated_at = ?, completed_at = ?
               WHERE run_id = ?""",
            (kind, event_sequence + 1, occurred_at, completed_at, run_id),
        )
        row = self._conn.execute(
            "SELECT * FROM task_events WHERE run_id = ? AND event_sequence = ?",
            (run_id, event_sequence),
        ).fetchone()
        assert row is not None
        return {"deduped": False, "event": self._task_event_from_row(row)}

    def record_task_event(self, event: Mapping[str, Any]) -> dict[str, Any]:
        run_id = _read_required_string(event, "runId")
        session_id = _read_required_string(event, "sessionId")
        kind = _read_required_string(event, "kind")
        occurred_at = _read_required_string(event, "occurredAt")
        if kind not in TASK_EVENT_KINDS:
            raise ValueError("invalid task event kind")
        event_sequence = event.get("sequence")
        if not isinstance(event_sequence, int) or event_sequence < 1:
            raise ValueError("sequence must be a positive integer")
        event_key = event.get("eventKey")
        if event_key is not None and (not isinstance(event_key, str) or not event_key):
            raise ValueError("eventKey must be a non-empty string")
        summary = event.get("summary")
        eta_sec = event.get("etaSec")
        if summary is not None and not isinstance(summary, str):
            raise ValueError("summary must be a string")
        if eta_sec is not None and (not isinstance(eta_sec, int) or eta_sec < 0):
            raise ValueError("etaSec must be a non-negative integer")
        with self._transaction():
            existing = self._conn.execute(
                "SELECT * FROM task_events WHERE run_id = ? AND event_sequence = ?",
                (run_id, event_sequence),
            ).fetchone()
            if existing is not None:
                current = self._task_event_from_row(existing)
                expected = {
                    "runId": run_id,
                    "sequence": event_sequence,
                    "sessionId": session_id,
                    "kind": kind,
                    "occurredAt": occurred_at,
                }
                if summary is not None:
                    expected["summary"] = summary
                if eta_sec is not None:
                    expected["etaSec"] = eta_sec
                if event_key is not None:
                    expected["eventKey"] = event_key
                if current != expected:
                    raise ValueError("task event sequence already exists with different payload")
                return {"deduped": True, "event": current}
            run = self._conn.execute(
                "SELECT * FROM task_runs WHERE run_id = ?", (run_id,)
            ).fetchone()
            if run is None:
                if event_sequence != 1 or kind != "started":
                    raise ValueError("first task event must be started sequence 1")
                self._conn.execute(
                    """INSERT INTO task_runs(
                         run_id, session_id, state, next_event_sequence,
                         started_at, updated_at, completed_at
                       ) VALUES (?, ?, ?, 2, ?, ?, ?)""",
                    (
                        run_id,
                        session_id,
                        kind,
                        occurred_at,
                        occurred_at,
                        occurred_at if kind in TASK_TERMINAL_STATES else None,
                    ),
                )
            else:
                if run["session_id"] != session_id:
                    raise ValueError("task event session does not match run")
                if int(run["next_event_sequence"]) != event_sequence:
                    raise ValueError("task event sequence must be strictly increasing")
                if run["state"] in TASK_TERMINAL_STATES:
                    raise ValueError(f"run is already terminal: {run['state']}")
            change_sequence = self._next_sequence_locked()
            self._conn.execute(
                """INSERT INTO task_events(
                     run_id, event_sequence, session_id, kind, event_key, summary,
                     eta_sec, occurred_at, change_sequence
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    run_id,
                    event_sequence,
                    session_id,
                    kind,
                    event_key,
                    summary,
                    eta_sec,
                    occurred_at,
                    change_sequence,
                ),
            )
            if run is not None:
                self._conn.execute(
                    """UPDATE task_runs
                       SET state = ?, next_event_sequence = ?, updated_at = ?, completed_at = ?
                       WHERE run_id = ?""",
                    (
                        kind,
                        event_sequence + 1,
                        occurred_at,
                        occurred_at if kind in TASK_TERMINAL_STATES else None,
                        run_id,
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
        for key in ("instanceId", "adapterId", "channel", "chatId"):
            _read_required_string(envelope, key)
        content = envelope.get("content")
        if not isinstance(content, str):
            raise ValueError("content must be a string")
        received_at = _read_required_string(envelope, "receivedAt")
        for key in ("threadId", "userId", "sessionId", "runId"):
            value = envelope.get(key)
            if value is not None and (not isinstance(value, str) or not value):
                raise ValueError(f"{key} must be a non-empty string or null")
        if len(content.encode("utf-8")) > MAX_CONTENT_BYTES:
            raise ValueError("inbound content exceeds maximum size")
        payload_json = _canonical_json(dict(envelope))
        if len(payload_json.encode("utf-8")) > MAX_CONTENT_BYTES + MAX_METADATA_BYTES:
            raise ValueError("inbound payload exceeds maximum size")
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
            is_head = self._update_conversation_head_locked(
                envelope, change_sequence, received_at
            )
            if is_head:
                self._cancel_superseded_messages_locked(envelope)
            return {"deduped": False, "inbound": dict(envelope)}

    def get_inbound_decision(self, inbound_message_id: str) -> dict[str, Any] | None:
        if not isinstance(inbound_message_id, str) or not inbound_message_id:
            raise ValueError("inbound_message_id must be a non-empty string")
        with self._lock:
            self._ensure_open()
            row = self._conn.execute(
                "SELECT decision_json, decided_at FROM inbound_decisions"
                " WHERE inbound_message_id = ?",
                (inbound_message_id,),
            ).fetchone()
            if row is None:
                return None
            decision = json.loads(row["decision_json"])
            decision["decidedAt"] = row["decided_at"]
            return decision

    def list_inbound_history(self, limit: int = 50) -> dict[str, Any]:
        bounded_limit = max(1, min(int(limit), 200))
        with self._lock:
            self._ensure_open()
            rows = self._conn.execute(
                """SELECT m.payload_json, m.received_at, d.decision_json, d.decided_at
                   FROM inbound_messages m
                   LEFT JOIN inbound_decisions d
                     ON d.inbound_message_id = m.inbound_message_id
                   ORDER BY m.received_at DESC, m.change_sequence DESC
                   LIMIT ?""",
                (bounded_limit,),
            ).fetchall()
            items = []
            for row in rows:
                inbound = json.loads(row["payload_json"])
                decision = None
                if row["decision_json"] is not None:
                    decision = json.loads(row["decision_json"])
                items.append(
                    {
                        "inboundMessageId": inbound.get("inboundMessageId"),
                        "inbound": inbound,
                        "decision": decision,
                        "decidedAt": row["decided_at"],
                    }
                )
            return {"items": items}

    def get_inbound(self, inbound_message_id: str) -> dict[str, Any] | None:
        if not isinstance(inbound_message_id, str) or not inbound_message_id:
            raise ValueError("inbound_message_id must be a non-empty string")
        with self._lock:
            self._ensure_open()
            row = self._conn.execute(
                "SELECT payload_json FROM inbound_messages WHERE inbound_message_id = ?",
                (inbound_message_id,),
            ).fetchone()
            return None if row is None else json.loads(row["payload_json"])

    def task_view(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            self._ensure_open()
            run = self._conn.execute(
                "SELECT * FROM task_runs WHERE run_id = ?", (run_id,)
            ).fetchone()
            if run is None:
                return None
            events = self._conn.execute(
                """SELECT * FROM task_events
                   WHERE run_id = ? ORDER BY event_sequence""",
                (run_id,),
            ).fetchall()
            outbound = self._conn.execute(
                """SELECT * FROM outbound_messages
                   WHERE run_id = ? ORDER BY sequence""",
                (run_id,),
            ).fetchall()
            inbound_payload = None
            if run["inbound_message_id"] is not None:
                inbound = self._conn.execute(
                    """SELECT payload_json FROM inbound_messages
                       WHERE inbound_message_id = ?""",
                    (run["inbound_message_id"],),
                ).fetchone()
                if inbound is not None:
                    inbound_payload = json.loads(inbound["payload_json"])
            view = self._run_from_row(run)
            view["inbound"] = inbound_payload
            view["events"] = [self._task_event_from_row(row) for row in events]
            view["outbound"] = [self._message_from_row(row) for row in outbound]
            return view

    def mark_dead_letter(
        self,
        message_id: str,
        expected_content_sha256: str,
        reason: str,
    ) -> dict[str, Any]:
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError("dead letter reason must be a non-empty string")
        with self._transaction():
            row = self._require_message_locked(message_id)
            if row["content_sha256"] != expected_content_sha256:
                raise ValueError("content hash conflict")
            if row["state"] == "delivery_unknown":
                raise ValueError("delivery_unknown requires explicit retry or cancellation review")
            if row["state"] not in DEAD_LETTER_SOURCE_STATES:
                raise ValueError(f"message cannot enter dead_letter from state {row['state']}")
            now = _utc_now()
            self._conn.execute(
                """UPDATE outbound_messages
                   SET state = 'dead_letter', active_attempt_id = NULL,
                       available_at = NULL, last_error = ?, updated_at = ?
                   WHERE message_id = ?""",
                (reason.strip(), now, message_id),
            )
            self._conn.execute(
                """INSERT INTO message_state_events(
                     event_id, message_id, from_state, to_state, reason, occurred_at
                   ) VALUES (?, ?, ?, 'dead_letter', ?, ?)""",
                (uuid7(), message_id, row["state"], reason.strip(), now),
            )
            return self._message_from_row(self._require_message_locked(message_id))

    def state_history(self, message_id: str) -> list[dict[str, Any]]:
        with self._lock:
            self._ensure_open()
            rows = self._conn.execute(
                """SELECT * FROM message_state_events
                   WHERE message_id = ? ORDER BY occurred_at, event_id""",
                (message_id,),
            ).fetchall()
            return [
                {
                    "eventId": row["event_id"],
                    "messageId": row["message_id"],
                    "fromState": row["from_state"],
                    "toState": row["to_state"],
                    "reason": row["reason"],
                    "occurredAt": row["occurred_at"],
                }
                for row in rows
            ]

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
            changes = payload.get("changes")
            if changes is not None and (
                not isinstance(changes, list) or not all(isinstance(item, str) for item in changes)
            ):
                raise ValueError("changes must be a string array when provided")
            mode = payload.get("mode")
            if mode is not None and mode not in {"pass-through", "quick", "rule", "llm"}:
                raise ValueError("mode must be one of pass-through, quick, rule, llm")
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
        if "event_key" in row.keys() and row["event_key"] is not None:
            event["eventKey"] = row["event_key"]
        return event

    @staticmethod
    def _run_from_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "runId": row["run_id"],
            "sessionId": row["session_id"],
            "inboundMessageId": row["inbound_message_id"],
            "supersedesRunId": row["supersedes_run_id"],
            "state": row["state"],
            "nextSequence": int(row["next_event_sequence"]),
            "startedAt": row["started_at"],
            "updatedAt": row["updated_at"],
            "completedAt": row["completed_at"],
        }
