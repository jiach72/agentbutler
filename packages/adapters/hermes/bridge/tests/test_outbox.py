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


def make_inbound(
    inbound_id: str,
    *,
    received_at: str,
    chat_id: str = "chat-1",
    thread_id: str | None = None,
) -> dict:
    return {
        "inboundMessageId": inbound_id,
        "instanceId": "hermes-main",
        "adapterId": "weixin",
        "channel": "weixin",
        "chatId": chat_id,
        "threadId": thread_id,
        "userId": "user-1",
        "sessionId": "session-1",
        "runId": None,
        "content": f"question:{inbound_id}",
        "receivedAt": received_at,
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

    def test_prune_history_deletes_only_old_terminal_messages_and_children(self) -> None:
        old = make_envelope("018bcfe5-6800-7000-8000-000000000021")
        fresh = make_envelope("018bcfe5-6800-7000-8000-000000000022")
        retry = make_envelope("018bcfe5-6800-7000-8000-000000000023")
        unknown = make_envelope("018bcfe5-6800-7000-8000-000000000024")

        self.outbox.capture(old)
        self.outbox.capture(fresh)
        self.outbox.capture(retry)
        self.outbox.capture(unknown)
        self.outbox._conn.execute(
            "UPDATE outbound_messages SET state = ?, updated_at = ? WHERE message_id = ?",
            ("delivered", "2026-08-01T00:00:00.000Z", old["messageId"]),
        )
        self.outbox._conn.execute(
            "UPDATE outbound_messages SET state = ?, updated_at = ? WHERE message_id = ?",
            ("delivered", "2026-08-23T00:00:00.000Z", fresh["messageId"]),
        )
        self.outbox._conn.execute(
            "UPDATE outbound_messages SET state = ?, updated_at = ? WHERE message_id = ?",
            ("retry_wait", "2026-08-01T00:00:00.000Z", retry["messageId"]),
        )
        self.outbox._conn.execute(
            "UPDATE outbound_messages SET state = ?, updated_at = ? WHERE message_id = ?",
            ("delivery_unknown", "2026-08-01T00:00:00.000Z", unknown["messageId"]),
        )
        self.outbox._conn.execute(
            "INSERT INTO message_state_events(event_id, message_id, from_state, to_state, reason, occurred_at) VALUES (?, ?, ?, ?, ?, ?)",
            ("state-old", old["messageId"], "captured", "delivered", "test", "2026-08-01T00:00:00.000Z"),
        )

        removed = self.outbox.prune_history("2026-08-08T00:00:00.000Z")

        self.assertEqual(removed, 2)
        self.assertIsNone(self.outbox.get(old["messageId"]))
        self.assertIsNotNone(self.outbox.get(fresh["messageId"]))
        self.assertEqual(self.outbox.get(retry["messageId"])["state"], "retry_wait")
        self.assertIsNone(self.outbox.get(unknown["messageId"]))
        self.assertEqual(
            self.outbox._conn.execute("SELECT COUNT(*) FROM message_state_events WHERE message_id = ?", (old["messageId"],)).fetchone()[0],
            0,
        )

    def test_capture_rejects_same_id_with_different_content(self) -> None:
        message_id = "018bcfe5-6800-7000-8000-000000000003"
        self.outbox.capture(make_envelope(message_id))

        with self.assertRaisesRegex(ValueError, "content hash"):
            self.outbox.capture(make_envelope(message_id, content="changed"))

    def test_new_inbound_does_not_cancel_unsent_terminal_reply_for_previous_question(self) -> None:
        first_inbound = make_inbound(
            "inbound-1", received_at="2026-08-23T10:00:00.000Z"
        )
        self.outbox.record_inbound(first_inbound)
        envelope = make_envelope("018bcfe5-6800-7000-8000-000000000005")
        captured = self.outbox.capture(envelope)
        self.assertEqual(captured["message"]["state"], "captured")

        self.outbox.record_inbound(
            make_inbound("inbound-2", received_at="2026-08-23T10:01:00.000Z")
        )

        previous = self.outbox.get(envelope["messageId"])
        self.assertEqual(previous["state"], "captured")
        self.assertIsNone(previous["lastError"])
        self.assertEqual(self.outbox.state_history(envelope["messageId"]), [])

    def test_new_inbound_does_not_cancel_delivery_unknown_terminal_reply(self) -> None:
        self.outbox.record_inbound(
            make_inbound("inbound-1", received_at="2026-08-23T10:00:00.000Z")
        )
        envelope = make_envelope("018bcfe5-6800-7000-8000-00000000000f")
        self.outbox.capture(envelope)
        self.outbox._conn.execute(
            """UPDATE outbound_messages
               SET state = 'delivery_unknown', last_error = 'uncertain delivery'
               WHERE message_id = ?""",
            (envelope["messageId"],),
        )

        self.outbox.record_inbound(
            make_inbound("inbound-2", received_at="2026-08-23T10:01:00.000Z")
        )

        row = self.outbox.get(envelope["messageId"])
        self.assertEqual(row["state"], "delivery_unknown")
        self.assertEqual(row["lastError"], "uncertain delivery")

    def test_late_reply_capture_for_previous_question_remains_deliverable(self) -> None:
        self.outbox.record_inbound(
            make_inbound("inbound-1", received_at="2026-08-23T10:00:00.000Z")
        )
        self.outbox.record_inbound(
            make_inbound("inbound-2", received_at="2026-08-23T10:01:00.000Z")
        )

        envelope = make_envelope("018bcfe5-6800-7000-8000-000000000006")
        captured = self.outbox.capture(envelope)

        self.assertEqual(captured["message"]["state"], "captured")
        self.assertIsNone(captured["message"]["lastError"])

    def test_explicit_run_supersede_cancels_previous_run_replies(self) -> None:
        self.outbox.record_inbound(
            make_inbound("inbound-run-old", received_at="2026-08-23T10:00:00.000Z")
        )
        old_run = self.outbox.begin_run(
            session_id="session-1",
            inbound_message_id="inbound-run-old",
            run_id="run-old",
        )
        self.assertFalse(old_run["deduped"])
        old = make_envelope("018bcfe5-6800-7000-8000-00000000000i")
        old.update({"runId": "run-old", "inboundMessageId": "inbound-run-old"})
        old["contentSha256"] = hashlib.sha256(old["content"].encode()).hexdigest()
        self.outbox.capture(old)

        self.outbox.record_inbound(
            make_inbound("inbound-run-new", received_at="2026-08-23T10:01:00.000Z")
        )
        self.outbox.begin_run(
            session_id="session-1",
            inbound_message_id="inbound-run-new",
            run_id="run-new",
            supersedes_run_id="run-old",
        )

        cancelled = self.outbox.get(old["messageId"])
        self.assertEqual(cancelled["state"], "cancelled")
        self.assertIn("superseded by explicit run run-new", cancelled["lastError"])

    def test_unlinked_queued_reply_is_forwarded_like_proactive(self) -> None:
        # 无入站关联的 queued-push 按主动外发放行：Hermes 定时任务/晨报（Cronjob
        # Response 等）正是这种形态，之前被误取消导致用户收不到晨报。
        reply = make_envelope("018bcfe5-6800-7000-8000-00000000000a")
        reply["runId"] = None
        reply["inboundMessageId"] = None
        reply["metadata"] = {}

        captured = self.outbox.capture(reply)

        self.assertEqual(captured["message"]["state"], "captured")
        self.assertNotIn("missing inbound correlation", captured["message"]["lastError"] or "")

        proactive = make_envelope("018bcfe5-6800-7000-8000-00000000000b")
        proactive["runId"] = None
        proactive["inboundMessageId"] = None
        proactive["metadata"] = {"proactive": True}

        self.assertEqual(self.outbox.capture(proactive)["message"]["state"], "captured")

        alert = make_envelope("018bcfe5-6800-7000-8000-00000000000c")
        alert["runId"] = None
        alert["inboundMessageId"] = None
        alert["messageKind"] = "alert"
        alert["metadata"] = {}

        self.assertEqual(self.outbox.capture(alert)["message"]["state"], "captured")

    def test_new_inbound_does_not_cancel_alerts_or_other_conversations(self) -> None:
        self.outbox.record_inbound(
            make_inbound("inbound-1", received_at="2026-08-23T10:00:00.000Z")
        )
        alert = make_envelope("018bcfe5-6800-7000-8000-000000000007")
        alert["messageKind"] = "alert"
        other = make_envelope("018bcfe5-6800-7000-8000-000000000008")
        other["chatId"] = "chat-2"
        self.outbox.capture(alert)
        self.outbox.capture(other)

        self.outbox.record_inbound(
            make_inbound("inbound-2", received_at="2026-08-23T10:01:00.000Z")
        )

        self.assertEqual(self.outbox.get(alert["messageId"])["state"], "captured")
        self.assertEqual(self.outbox.get(other["messageId"])["state"], "captured")

    def test_reopen_cancels_legacy_backlog_for_superseded_question(self) -> None:
        self.outbox.record_inbound(
            make_inbound("inbound-1", received_at="2026-08-23T10:00:00.000Z")
        )
        envelope = make_envelope("018bcfe5-6800-7000-8000-000000000009")
        envelope["messageKind"] = "task-progress"
        self.outbox.capture(envelope)
        self.outbox.record_inbound(
            make_inbound("inbound-2", received_at="2026-08-23T10:01:00.000Z")
        )
        self.outbox._conn.execute(
            """UPDATE outbound_messages
               SET state = 'retry_wait', last_error = 'legacy retry'
               WHERE message_id = ?""",
            (envelope["messageId"],),
        )
        self.outbox._conn.execute("DELETE FROM conversation_heads")

        self.reopen()

        row = self.outbox.get(envelope["messageId"])
        self.assertEqual(row["state"], "cancelled")
        self.assertIn("superseded by newer inbound", row["lastError"])

    def test_reopen_does_not_cancel_legacy_unlinked_queued_replies(self) -> None:
        retry = make_envelope("018bcfe5-6800-7000-8000-00000000000d")
        unknown = make_envelope("018bcfe5-6800-7000-8000-00000000000e")
        self.outbox.capture(retry)
        self.outbox.capture(unknown)
        self.outbox._conn.execute(
            """UPDATE outbound_messages
               SET inbound_message_id = NULL, run_id = NULL, metadata_json = '{}',
                   state = CASE message_id WHEN ? THEN 'retry_wait' ELSE 'delivery_unknown' END,
                   last_error = 'legacy backlog'
               WHERE message_id IN (?, ?)""",
            (retry["messageId"], retry["messageId"], unknown["messageId"]),
        )

        self.reopen()

        for message_id in (retry["messageId"], unknown["messageId"]):
            row = self.outbox.get(message_id)
            # 无关联 queued-push 消息不再被启动扫描取消（主动外发合法）。
            self.assertNotEqual(row["state"], "cancelled")

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

    def _capture_and_ready(self, message_id: str, decision_id: str) -> dict:
        envelope = make_envelope(message_id)
        captured = self.outbox.capture(envelope)
        self.outbox.apply_decision(
            message_id,
            decision_id,
            envelope["contentSha256"],
            "ready",
            None,
            [],
            "policy-1",
            "ready",
        )
        return envelope, captured["message"]["sequence"]

    def test_delivery_transitions_allocate_change_sequences(self) -> None:
        envelope, captured_seq = self._capture_and_ready(
            "018bcfe5-6800-7000-8000-000000000301", "decision-seq-1"
        )
        message_id = envelope["messageId"]

        begun = self.outbox.begin_delivery(message_id, "attempt-seq-1", envelope["contentSha256"])

        self.assertGreater(begun["message"]["sequence"], captured_seq)
        delivering = self.outbox.list_changes(captured_seq)
        self.assertEqual([item["state"] for item in delivering["items"]], ["delivering"])

        finished = self.outbox.finish_delivery(message_id, "attempt-seq-1", "provider-seq-1")

        self.assertGreater(finished["sequence"], begun["message"]["sequence"])
        delivered = self.outbox.list_changes(begun["message"]["sequence"])
        self.assertEqual([item["state"] for item in delivered["items"]], ["delivered"])
        self.assertEqual(delivered["items"][0]["providerMessageId"], "provider-seq-1")

    def test_retry_and_dead_letter_transitions_allocate_change_sequences(self) -> None:
        envelope, captured_seq = self._capture_and_ready(
            "018bcfe5-6800-7000-8000-000000000302", "decision-seq-2"
        )
        message_id = envelope["messageId"]
        begun = self.outbox.begin_delivery(message_id, "attempt-seq-2", envelope["contentSha256"])
        self.assertGreater(begun["message"]["sequence"], captured_seq)

        retried = self.outbox.mark_retry(message_id, "attempt-seq-2", "provider 500")

        self.assertGreater(retried["sequence"], begun["message"]["sequence"])
        retry_feed = self.outbox.list_changes(begun["message"]["sequence"])
        self.assertEqual([item["state"] for item in retry_feed["items"]], ["retry_wait"])

        dead = self.outbox.mark_dead_letter(
            message_id, envelope["contentSha256"], "manual review"
        )

        self.assertGreater(dead["sequence"], retried["sequence"])
        dead_feed = self.outbox.list_changes(retried["sequence"])
        self.assertEqual([item["state"] for item in dead_feed["items"]], ["dead_letter"])

    def test_stale_delivering_recovery_allocates_change_sequence(self) -> None:
        envelope, captured_seq = self._capture_and_ready(
            "018bcfe5-6800-7000-8000-000000000303", "decision-seq-3"
        )
        message_id = envelope["messageId"]
        begun = self.outbox.begin_delivery(message_id, "attempt-seq-3", envelope["contentSha256"])

        self.reopen()

        recovered = self.outbox.get(message_id)
        self.assertEqual(recovered["state"], "delivery_unknown")
        self.assertGreater(recovered["sequence"], begun["message"]["sequence"])
        feed = self.outbox.list_changes(captured_seq)
        self.assertEqual(
            [(item["messageId"], item["state"]) for item in feed["items"]],
            [(message_id, "delivery_unknown")],
        )

        # 高水位必须随恢复推进：新库实例重启后新消息的 sequence 不得回退。
        followup = make_envelope("018bcfe5-6800-7000-8000-000000000304")
        followup["inboundMessageId"] = None
        followup["runId"] = None
        new_capture = self.outbox.capture(followup)
        self.assertGreater(new_capture["message"]["sequence"], recovered["sequence"])

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

    def test_reopen_backfills_decision_history_then_replay_reapplies_semantic_decision(self) -> None:
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
        # The gateway only replays its own staged decision, so re-applying the
        # semantic decision is correct even if the row moved on in between
        # (e.g. ready -> held_pacing -> ready). The replayed decision uses the
        # content it would produce, not the superseded envelope hash.
        replay = self.outbox.apply_decision(
            envelope["messageId"],
            "decision-1",
            first["contentSha256"],
            "held_pacing",
            "2026-08-22T10:00:30.000Z",
            ["aggregate-progress"],
            "p1",
            "paced",
            optimized_content="digest",
        )

        self.assertEqual(replay["contentSha256"], first["contentSha256"])
        self.assertEqual(replay["state"], "held_pacing")
        self.assertEqual(replay["transformTrace"], ["aggregate-progress"])

    def test_startup_migrates_runtime_columns_for_existing_outbox(self) -> None:
        self.outbox.close()
        legacy = sqlite3.connect(self.db_path)
        legacy.executescript(
            DDL.replace("  decision_id TEXT,\n", "").replace(
                "  delivery_route_json TEXT,\n", ""
            )
        )
        legacy.close()

        self.outbox = Outbox(self.db_path)

        columns = self.outbox._conn.execute("PRAGMA table_info(outbound_messages)").fetchall()
        column_names = {column[1] for column in columns}
        self.assertIn("decision_id", column_names)
        self.assertIn("delivery_route_json", column_names)

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

    def test_dead_letter_from_delivering_with_allow_flag_finishes_attempt(self) -> None:
        message = make_envelope("018bcfe5-6800-7000-8000-000000000504")
        self.outbox.capture(message)
        attempt_id = "attempt-passthrough-1"
        self.outbox.begin_delivery(
            message["messageId"],
            attempt_id,
            message["contentSha256"],
            allow_captured=True,
        )

        dead = self.outbox.mark_dead_letter(
            message["messageId"],
            message["contentSha256"],
            "native send failed: rate limited",
            allow_delivering=True,
        )

        self.assertEqual(dead["state"], "dead_letter")
        row = self.outbox.get(message["messageId"])
        self.assertEqual(row["state"], "dead_letter")
        self.assertIn("rate limited", row["lastError"])
        attempt = self.outbox._conn.execute(
            "SELECT finished_at, outcome, error FROM delivery_attempts WHERE attempt_id = ?",
            (attempt_id,),
        ).fetchone()
        self.assertIsNotNone(attempt["finished_at"])
        self.assertEqual(attempt["outcome"], "failed")
        self.assertIn("rate limited", attempt["error"])
        history = self.outbox.state_history(message["messageId"])
        self.assertEqual(history[-1]["fromState"], "delivering")
        self.assertEqual(history[-1]["toState"], "dead_letter")

    def test_dead_letter_from_delivering_without_flag_is_rejected(self) -> None:
        message = make_envelope("018bcfe5-6800-7000-8000-000000000505")
        self.outbox.capture(message)
        attempt_id = "attempt-passthrough-2"
        self.outbox.begin_delivery(
            message["messageId"],
            attempt_id,
            message["contentSha256"],
            allow_captured=True,
        )

        with self.assertRaisesRegex(ValueError, "delivering"):
            self.outbox.mark_dead_letter(
                message["messageId"],
                message["contentSha256"],
                "native send failed",
            )

        self.assertEqual(self.outbox.get(message["messageId"])["state"], "delivering")
        attempt = self.outbox._conn.execute(
            "SELECT finished_at FROM delivery_attempts WHERE attempt_id = ?",
            (attempt_id,),
        ).fetchone()
        self.assertIsNone(attempt["finished_at"])

    def test_task_results_can_be_finalized_and_duplicate_results_absorbed(self) -> None:
        started = self.outbox.begin_run(session_id="session-summary", run_id="run-summary")
        first = make_envelope("018bcfe5-6800-7000-8000-000000000601")
        first.update({"runId": "run-summary", "messageKind": "final", "chatId": "chat-1"})
        first["contentSha256"] = hashlib.sha256(first["content"].encode()).hexdigest()
        second = dict(first)
        second["messageId"] = "018bcfe5-6800-7000-8000-000000000602"
        second["content"] = "重复结果"
        second["contentSha256"] = hashlib.sha256(second["content"].encode()).hexdigest()
        self.outbox.capture(first)
        self.outbox.capture(second)

        finalized = self.outbox.finalize_pending_message(
            first["messageId"],
            content="结论：任务已完成\n已完成：已执行\n异常：无\n下一步：无",
            metadata_updates={"summaryStatus": "success", "taskCanonical": True},
        )
        self.assertEqual(finalized["metadata"]["summaryStatus"], "success")
        absorbed = self.outbox.absorb_message(second["messageId"])
        self.assertEqual(absorbed["state"], "absorbed")

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


    def test_inbound_decision_roundtrip_and_history_join(self) -> None:
        self.outbox.record_inbound(
            {
                "inboundMessageId": "inbound-opt-1",
                "instanceId": "hermes-main",
                "adapterId": "weixin",
                "channel": "weixin",
                "chatId": "chat-1",
                "content": "帮我把那个论文技能弄好点",
                "receivedAt": "2026-08-23T00:00:01.000Z",
            }
        )
        self.assertIsNone(self.outbox.get_inbound_decision("inbound-opt-1"))

        decision = {
            "inboundMessageId": "inbound-opt-1",
            "action": "forward",
            "optimizedText": "改进论文技能",
            "transformTrace": ["optimize:strip-filler"],
            "changes": ["去掉开头的客套话"],
            "mode": "rule",
        }
        self.outbox.apply_inbound_decision("inbound-opt-1", decision)

        stored = self.outbox.get_inbound_decision("inbound-opt-1")
        self.assertEqual(stored["mode"], "rule")
        self.assertEqual(stored["optimizedText"], "改进论文技能")
        self.assertIn("decidedAt", stored)

        history = self.outbox.list_inbound_history(10)
        self.assertEqual(len(history["items"]), 1)
        item = history["items"][0]
        self.assertEqual(item["inboundMessageId"], "inbound-opt-1")
        self.assertEqual(item["inbound"]["content"], "帮我把那个论文技能弄好点")
        self.assertEqual(item["decision"]["changes"], ["去掉开头的客套话"])

        replacement = {**decision, "optimizedText": "改进论文技能，避免上次的失败"}
        self.outbox.apply_inbound_decision("inbound-opt-1", replacement)
        self.assertEqual(
            self.outbox.get_inbound_decision("inbound-opt-1")["optimizedText"],
            "改进论文技能，避免上次的失败",
        )
        llm_replacement = {
            **decision,
            "mode": "llm",
            "optimizedText": "改进论文技能，并报告结果",
            "transformTrace": ["optimize:llm-fallback"],
            "changes": ["由 AI 改写"],
        }
        self.outbox.apply_inbound_decision("inbound-opt-1", llm_replacement)
        self.assertEqual(self.outbox.get_inbound_decision("inbound-opt-1")["mode"], "llm")

    def test_inbound_history_orders_by_received_at_and_bounds_limit(self) -> None:
        for index, received_at in enumerate(
            ("2026-08-23T00:00:02.000Z", "2026-08-23T00:00:03.000Z", "2026-08-23T00:00:01.000Z")
        ):
            self.outbox.record_inbound(
                {
                    "inboundMessageId": f"inbound-order-{index}",
                    "instanceId": "hermes-main",
                    "adapterId": "weixin",
                    "channel": "weixin",
                    "chatId": "chat-1",
                    "content": f"message-{index}",
                    "receivedAt": received_at,
                }
            )

        history = self.outbox.list_inbound_history(2)
        self.assertEqual(len(history["items"]), 2)
        self.assertEqual(history["items"][0]["inboundMessageId"], "inbound-order-1")
        self.assertEqual(history["items"][1]["inboundMessageId"], "inbound-order-0")
        self.assertIsNone(history["items"][0]["decision"])
        self.assertIsNone(history["items"][0]["decidedAt"])

    def test_inbound_decision_rejects_invalid_changes_and_mode(self) -> None:
        self.outbox.record_inbound(
            {
                "inboundMessageId": "inbound-invalid-1",
                "instanceId": "hermes-main",
                "adapterId": "weixin",
                "channel": "weixin",
                "chatId": "chat-1",
                "content": "hello",
                "receivedAt": "2026-08-23T00:00:04.000Z",
            }
        )
        base = {
            "inboundMessageId": "inbound-invalid-1",
            "action": "forward",
            "optimizedText": "hello",
            "transformTrace": [],
        }
        with self.assertRaisesRegex(ValueError, "changes"):
            self.outbox.apply_inbound_decision("inbound-invalid-1", {**base, "changes": "oops"})
        with self.assertRaisesRegex(ValueError, "changes"):
            self.outbox.apply_inbound_decision(
                "inbound-invalid-1", {**base, "changes": ["ok", 42]}
            )
        with self.assertRaisesRegex(ValueError, "mode"):
            self.outbox.apply_inbound_decision("inbound-invalid-1", {**base, "mode": 42})


if __name__ == "__main__":
    unittest.main()
