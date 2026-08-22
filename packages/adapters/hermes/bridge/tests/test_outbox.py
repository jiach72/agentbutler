import hashlib
import json
import sqlite3
import tempfile
import unittest
import uuid
from pathlib import Path

from agent_butler_bridge.ids import uuid7
from agent_butler_bridge.outbox import DDL, Outbox


def make_envelope(message_id: str, *, content: str = "hello") -> dict:
    return {
        "messageId": message_id,
        "instanceId": "hermes-main",
        "adapterId": "weixin",
        "channel": "weixin",
        "accountId": "wx-account",
        "chatId": "chat-1",
        "threadId": None,
        "sessionId": "session-1",
        "runId": "run-1",
        "inboundMessageId": "inbound-1",
        "messageKind": "final",
        "transport": "queued-push",
        "priority": "normal",
        "content": content,
        "contentSha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
        "replyTo": None,
        "metadata": {"notify": True},
        "capturedAt": "2026-08-22T00:00:00.000Z",
    }


class OutboxTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "outbox.sqlite"
        self.outbox = Outbox(self.db_path)

    def tearDown(self) -> None:
        self.outbox.close()
        self.tmp.cleanup()

    def reopen(self) -> None:
        self.outbox.close()
        self.outbox = Outbox(self.db_path)

    def test_uuid7_has_version_7_and_sorts_by_time(self) -> None:
        first = uuid7(now_ms=1_700_000_000_000, random_bytes=b"\x00" * 10)
        second = uuid7(now_ms=1_700_000_000_001, random_bytes=b"\x00" * 10)

        self.assertEqual(uuid.UUID(first).version, 7)
        self.assertEqual(uuid.UUID(first).variant, uuid.RFC_4122)
        self.assertLess(first, second)

    def test_uuid7_validates_inputs(self) -> None:
        with self.assertRaises(ValueError):
            uuid7(now_ms=-1, random_bytes=b"\x00" * 10)
        with self.assertRaises(ValueError):
            uuid7(now_ms=1, random_bytes=b"short")

    def test_capture_is_idempotent_across_reopen(self) -> None:
        envelope = make_envelope("018bcfe5-6800-7000-8000-000000000001")

        first = self.outbox.capture(envelope)
        duplicate = self.outbox.capture(envelope)

        self.assertFalse(first["deduped"])
        self.assertTrue(duplicate["deduped"])
        self.assertEqual(first["message"]["sequence"], duplicate["message"]["sequence"])
        self.reopen()
        self.assertEqual(self.outbox.get(envelope["messageId"])["state"], "captured")

    def test_capture_rejects_same_id_with_different_content(self) -> None:
        message_id = "018bcfe5-6800-7000-8000-000000000003"
        self.outbox.capture(make_envelope(message_id))

        with self.assertRaisesRegex(ValueError, "content hash"):
            self.outbox.capture(make_envelope(message_id, content="changed"))

    def test_delivery_unknown_is_not_claimable_after_restart(self) -> None:
        envelope = make_envelope("018bcfe5-6800-7000-8000-000000000002")
        self.outbox.capture(envelope)
        self.outbox.apply_decision(
            envelope["messageId"],
            "decision-delivery-unknown",
            envelope["contentSha256"],
            "ready",
            None,
            [],
            "policy-1",
            "ready for delivery",
        )
        self.outbox.begin_delivery(
            envelope["messageId"],
            "attempt-1",
            envelope["contentSha256"],
        )
        self.outbox.mark_unknown(
            envelope["messageId"],
            "attempt-1",
            "process exited after send",
        )

        self.reopen()

        self.assertIsNone(self.outbox.next_ready("2100-01-01T00:00:00.000Z"))
        self.assertEqual(self.outbox.get(envelope["messageId"])["state"], "delivery_unknown")

    def test_stale_delivering_becomes_unknown_on_reopen(self) -> None:
        envelope = make_envelope("018bcfe5-6800-7000-8000-000000000004")
        self.outbox.capture(envelope)
        self.outbox.apply_decision(
            envelope["messageId"],
            "decision-stale-delivering",
            envelope["contentSha256"],
            "ready",
            None,
            [],
            "policy-1",
            "ready",
        )
        self.outbox.begin_delivery(
            envelope["messageId"],
            "attempt-crash",
            envelope["contentSha256"],
        )

        self.reopen()

        row = self.outbox.get(envelope["messageId"])
        self.assertEqual(row["state"], "delivery_unknown")
        self.assertIn("recovered stale delivering", row["lastError"])

    def test_same_decision_id_is_idempotent_after_content_transform(self) -> None:
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

    def test_reopen_backfills_decision_history_before_replaying_older_decision(self) -> None:
        envelope = make_envelope("018bcfe5-6800-7000-8000-000000000104")
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
        self.outbox._conn.execute(
            """CREATE TABLE IF NOT EXISTS outbound_decisions (
                 decision_id TEXT PRIMARY KEY,
                 message_id TEXT NOT NULL,
                 applied_at TEXT NOT NULL
               )"""
        )
        self.outbox._conn.execute(
            "DELETE FROM outbound_decisions WHERE decision_id = ?", ("decision-1",)
        )

        self.reopen()

        second = self.outbox.apply_decision(
            envelope["messageId"],
            "decision-2",
            first["contentSha256"],
            "ready",
            None,
            ["ready"],
            "p2",
            "ready",
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

        self.assertEqual(replay["contentSha256"], second["contentSha256"])
        self.assertEqual(replay["state"], "ready")
        self.assertEqual(replay["transformTrace"], ["ready"])

    def test_startup_migrates_decision_id_for_existing_outbox(self) -> None:
        self.outbox.close()
        legacy = sqlite3.connect(self.db_path)
        legacy.executescript(DDL.replace("  decision_id TEXT,\n", ""))
        legacy.close()

        self.outbox = Outbox(self.db_path)

        columns = self.outbox._conn.execute("PRAGMA table_info(outbound_messages)").fetchall()
        self.assertIn("decision_id", {column[1] for column in columns})

    def test_startup_migrates_legacy_task_events_and_backfills_run(self) -> None:
        self.outbox.close()
        for suffix in ("", "-wal", "-shm"):
            Path(str(self.db_path) + suffix).unlink(missing_ok=True)
        legacy = sqlite3.connect(self.db_path)
        legacy.executescript(
            """
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
            INSERT INTO task_events(
              run_id, event_sequence, session_id, kind, occurred_at, change_sequence
            ) VALUES ('legacy-run', 1, 'legacy-session', 'started',
                      '2026-08-22T00:00:00.000Z', 1);
            """
        )
        legacy.close()

        self.outbox = Outbox(self.db_path)

        columns = self.outbox._conn.execute("PRAGMA table_info(task_events)").fetchall()
        self.assertIn("event_key", {column[1] for column in columns})
        view = self.outbox.task_view("legacy-run")
        self.assertEqual(view["sessionId"], "legacy-session")
        self.assertEqual(view["nextSequence"], 2)

    def test_decision_id_cannot_apply_to_another_message(self) -> None:
        first = make_envelope("018bcfe5-6800-7000-8000-000000000102")
        second = make_envelope("018bcfe5-6800-7000-8000-000000000103")
        self.outbox.capture(first)
        self.outbox.capture(second)
        self.outbox.apply_decision(
            first["messageId"],
            "decision-shared",
            first["contentSha256"],
            "ready",
            None,
            [],
            "p1",
            "ready",
        )

        with self.assertRaisesRegex(ValueError, "decision id conflict"):
            self.outbox.apply_decision(
                second["messageId"],
                "decision-shared",
                second["contentSha256"],
                "ready",
                None,
                [],
                "p1",
                "ready",
            )

    def test_policy_snapshot_survives_reopen(self) -> None:
        payload = {"inlineResponse": "allow"}
        payload_hash = hashlib.sha256(
            json.dumps(
                payload,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()
        self.outbox.set_policy_snapshot(
            "policy-1",
            payload_hash,
            payload,
        )

        self.reopen()

        self.assertEqual(
            self.outbox.get_policy_snapshot(),
            {
                "version": "policy-1",
                "sha256": payload_hash,
                "payload": {"inlineResponse": "allow"},
            },
        )

    def test_policy_snapshot_rejects_hash_mismatch(self) -> None:
        with self.assertRaisesRegex(ValueError, "policy snapshot hash"):
            self.outbox.set_policy_snapshot(
                "policy-1",
                "wrong",
                {"inlineResponse": "allow"},
            )

    def test_change_feed_contains_messages_tasks_and_inbound(self) -> None:
        envelope = make_envelope("018bcfe5-6800-7000-8000-000000000005")
        self.outbox.capture(envelope)
        self.outbox.record_task_event(
            {
                "runId": "run-1",
                "sequence": 1,
                "sessionId": "session-1",
                "kind": "started",
                "occurredAt": "2026-08-22T00:00:01.000Z",
            }
        )
        self.outbox.record_inbound(
            {
                "inboundMessageId": "inbound-2",
                "instanceId": "hermes-main",
                "adapterId": "weixin",
                "channel": "weixin",
                "chatId": "chat-1",
                "content": "status",
                "receivedAt": "2026-08-22T00:00:02.000Z",
            }
        )

        batch = self.outbox.list_changes(0, 20)

        self.assertEqual(len(batch["items"]), 1)
        self.assertEqual(len(batch["taskEvents"]), 1)
        self.assertEqual(len(batch["inbound"]), 1)
        self.assertGreaterEqual(batch["nextSequence"], 3)

    def test_run_lifecycle_binds_inbound_and_allocates_strict_sequence(self) -> None:
        self.outbox.record_inbound(
            {
                "inboundMessageId": "inbound-run-1",
                "instanceId": "hermes-main",
                "adapterId": "weixin:default",
                "channel": "weixin",
                "chatId": "chat-1",
                "userId": "user-1",
                "content": "do work",
                "receivedAt": "2026-08-22T01:00:00.000Z",
            }
        )

        started = self.outbox.begin_run(
            session_id="session-run-1",
            inbound_message_id="inbound-run-1",
            run_id="run-lifecycle-1",
            occurred_at="2026-08-22T01:00:01.000Z",
        )
        progress = self.outbox.append_task_event(
            "run-lifecycle-1",
            "progress",
            summary="step 1",
            eta_sec=30,
            event_key="tool:1:started",
            occurred_at="2026-08-22T01:00:02.000Z",
        )
        replay = self.outbox.append_task_event(
            "run-lifecycle-1",
            "progress",
            summary="step 1",
            eta_sec=30,
            event_key="tool:1:started",
            occurred_at="2026-08-22T01:00:02.000Z",
        )
        completing = self.outbox.append_task_event(
            "run-lifecycle-1",
            "completing",
            event_key="lifecycle:completing",
            occurred_at="2026-08-22T01:00:03.000Z",
        )
        done = self.outbox.finish_run(
            "run-lifecycle-1",
            summary="delivered",
            occurred_at="2026-08-22T01:00:04.000Z",
        )
        done_replay = self.outbox.finish_run(
            "run-lifecycle-1",
            summary="delivered",
            occurred_at="2026-08-22T01:00:05.000Z",
        )

        self.assertEqual(started["event"]["sequence"], 1)
        self.assertEqual(progress["event"]["sequence"], 2)
        self.assertTrue(replay["deduped"])
        self.assertEqual(completing["event"]["sequence"], 3)
        self.assertEqual(done["event"]["sequence"], 4)
        self.assertTrue(done_replay["deduped"])
        self.assertEqual(done_replay["event"]["sequence"], 4)
        with self.assertRaisesRegex(ValueError, "terminal"):
            self.outbox.append_task_event("run-lifecycle-1", "progress", summary="late")

        view = self.outbox.task_view("run-lifecycle-1")
        self.assertEqual(view["state"], "done")
        self.assertEqual(view["inbound"]["runId"], "run-lifecycle-1")
        self.assertEqual(view["inbound"]["sessionId"], "session-run-1")
        self.assertEqual([event["sequence"] for event in view["events"]], [1, 2, 3, 4])

    def test_media_only_inbound_accepts_empty_text(self) -> None:
        recorded = self.outbox.record_inbound(
            {
                "inboundMessageId": "inbound-media-only",
                "instanceId": "hermes-main",
                "adapterId": "weixin:default",
                "channel": "weixin",
                "chatId": "chat-1",
                "content": "",
                "receivedAt": "2026-08-22T01:30:00.000Z",
            }
        )

        self.assertFalse(recorded["deduped"])
        self.assertEqual(recorded["inbound"]["content"], "")

    def test_begin_run_records_superseded_run(self) -> None:
        first = self.outbox.begin_run(session_id="session-1", run_id="run-old")
        second = self.outbox.begin_run(
            session_id="session-1",
            run_id="run-new",
            supersedes_run_id="run-old",
        )

        self.assertFalse(first["deduped"])
        self.assertEqual(second["run"]["supersedesRunId"], "run-old")

    def test_dead_letter_is_audited_and_rejects_delivery_unknown(self) -> None:
        message = make_envelope("018bcfe5-6800-7000-8000-000000000501")
        self.outbox.capture(message)

        dead = self.outbox.mark_dead_letter(
            message["messageId"],
            message["contentSha256"],
            "invalid route metadata",
        )

        self.assertEqual(dead["state"], "dead_letter")
        self.assertEqual(self.outbox.state_history(message["messageId"])[0]["toState"], "dead_letter")

        uncertain = make_envelope("018bcfe5-6800-7000-8000-000000000502")
        self.outbox.capture(uncertain)
        self.outbox.apply_decision(
            uncertain["messageId"],
            "decision-unknown-2",
            uncertain["contentSha256"],
            "ready",
            None,
            [],
            "policy-1",
            "ready",
        )
        self.outbox.begin_delivery(uncertain["messageId"], "attempt-unknown-2", uncertain["contentSha256"])
        self.outbox.mark_unknown(uncertain["messageId"], "attempt-unknown-2", "timeout")
        with self.assertRaisesRegex(ValueError, "delivery_unknown"):
            self.outbox.mark_dead_letter(
                uncertain["messageId"],
                uncertain["contentSha256"],
                "must not convert uncertainty",
            )

    def test_capture_commits_attachment_metadata_without_exposing_spool_path(self) -> None:
        message = make_envelope("018bcfe5-6800-7000-8000-000000000503")
        spool_path = Path(self.tmp.name) / "spool" / "message" / "file.txt"
        spool_path.parent.mkdir(parents=True)
        spool_path.write_text("hello", encoding="utf-8")
        message["attachments"] = [
            {
                "attachmentId": "attachment-1",
                "fileName": "file.txt",
                "mimeType": "text/plain",
                "sizeBytes": 5,
                "sha256": hashlib.sha256(b"hello").hexdigest(),
                "spoolPath": str(spool_path),
            }
        ]

        self.outbox.capture(message)

        public = self.outbox.attachments_for(message["messageId"])
        internal = self.outbox.attachments_for(message["messageId"], include_paths=True)
        self.assertNotIn("spoolPath", public[0])
        self.assertEqual(internal[0]["spoolPath"], str(spool_path))


if __name__ == "__main__":
    unittest.main()
