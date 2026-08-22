import hashlib
import json
import tempfile
import unittest
import uuid
from pathlib import Path

from agent_butler_bridge.ids import uuid7
from agent_butler_bridge.outbox import Outbox


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


if __name__ == "__main__":
    unittest.main()
