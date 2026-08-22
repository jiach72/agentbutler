import hashlib
import json
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

from agent_butler_bridge.context import message_context
from agent_butler_bridge.outbox import Outbox
from agent_butler_bridge.registry import NativeRegistry
from agent_butler_bridge.wrapper import attach_adapter


@dataclass
class FakeSendResult:
    success: bool
    message_id: str | None = None
    error: str | None = None


class FakeAdapter:
    def __init__(self) -> None:
        self.native_calls: list[tuple] = []
        self.native_edits: list[tuple] = []

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        self.native_calls.append((chat_id, content, reply_to, metadata))
        return FakeSendResult(success=True, message_id="provider-1")

    async def edit_message(self, chat_id, message_id, content, *, finalize=False):
        self.native_edits.append((chat_id, message_id, content, finalize))
        return FakeSendResult(success=True, message_id=message_id)


class WrapperTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.outbox = Outbox(Path(self.tmp.name) / "outbox.sqlite")
        self.registry = NativeRegistry(self.outbox, instance_id="hermes-main")
        self.adapter = FakeAdapter()

    async def asyncTearDown(self) -> None:
        self.outbox.close()
        self.tmp.cleanup()

    async def test_queued_push_persists_without_native_send(self) -> None:
        attach_adapter(
            self.adapter,
            self.registry,
            adapter_id="weixin",
            channel="weixin",
        )

        result = await self.adapter.send(
            "chat-1",
            "hello",
            metadata={"butler_session_id": "s1", "notify": True},
        )

        self.assertTrue(result.success)
        self.assertTrue(result.message_id.startswith("butler:"))
        self.assertEqual(self.adapter.native_calls, [])
        row = self.outbox.list_changes(0, 10)["items"][0]
        self.assertEqual(row["transport"], "queued-push")
        self.assertEqual(row["metadata"], {"notify": True})

    async def test_inline_response_persists_then_calls_native(self) -> None:
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
        attach_adapter(
            self.adapter,
            self.registry,
            adapter_id="a2a",
            channel="a2a",
        )

        result = await self.adapter.send(
            "ctx-1",
            "answer",
            metadata={
                "butler_transport": "inline-response",
                "butler_session_id": "s1",
            },
        )

        self.assertEqual(result.message_id, "provider-1")
        self.assertEqual(len(self.adapter.native_calls), 1)
        row = self.outbox.list_changes(0, 10)["items"][0]
        self.assertEqual(row["state"], "delivered")
        self.assertEqual(row["providerMessageId"], "provider-1")

    async def test_attach_is_idempotent(self) -> None:
        first = attach_adapter(
            self.adapter,
            self.registry,
            adapter_id="weixin",
            channel="weixin",
        )
        second = attach_adapter(
            self.adapter,
            self.registry,
            adapter_id="weixin",
            channel="weixin",
        )

        self.assertIs(first, second)

    async def test_inline_response_fails_closed_without_policy_snapshot(self) -> None:
        attach_adapter(
            self.adapter,
            self.registry,
            adapter_id="a2a",
            channel="a2a",
        )

        result = await self.adapter.send(
            "ctx-1",
            "answer",
            metadata={
                "butler_transport": "inline-response",
                "butler_session_id": "s1",
            },
        )

        self.assertFalse(result.success)
        self.assertIn("policy snapshot", result.error)
        self.assertEqual(self.adapter.native_calls, [])
        self.assertEqual(self.outbox.list_changes(0, 10)["items"][0]["state"], "policy_error")

    async def test_sensitive_metadata_is_not_persisted(self) -> None:
        attach_adapter(
            self.adapter,
            self.registry,
            adapter_id="weixin",
            channel="weixin",
        )

        await self.adapter.send(
            "chat-1",
            "hello",
            metadata={
                "authorization": "Bearer secret",
                "apiToken": "secret",
                "nested": {"password": "secret", "safe": 1},
            },
        )

        metadata = self.outbox.list_changes(0, 10)["items"][0]["metadata"]
        self.assertNotIn("authorization", metadata)
        self.assertNotIn("apiToken", metadata)
        self.assertEqual(metadata["nested"], {"safe": 1})

    async def test_synthetic_edit_updates_pending_message_without_native_edit(self) -> None:
        attach_adapter(
            self.adapter,
            self.registry,
            adapter_id="weixin",
            channel="weixin",
        )
        sent = await self.adapter.send(
            "chat-1",
            "draft",
            metadata={"butler_session_id": "s1"},
        )

        edited = await self.adapter.edit_message(
            "chat-1",
            sent.message_id,
            "final content",
            finalize=True,
        )

        self.assertTrue(edited.success)
        self.assertEqual(edited.message_id, sent.message_id)
        self.assertEqual(self.adapter.native_edits, [])
        message_id = sent.message_id.removeprefix("butler:")
        self.assertEqual(self.outbox.get(message_id)["content"], "final content")

    async def test_registry_delivery_is_idempotent(self) -> None:
        attach_adapter(
            self.adapter,
            self.registry,
            adapter_id="weixin",
            channel="weixin",
        )
        sent = await self.adapter.send(
            "chat-1",
            "hello",
            metadata={"butler_session_id": "s1"},
        )
        message_id = sent.message_id.removeprefix("butler:")
        captured = self.outbox.get(message_id)
        self.outbox.apply_decision(
            message_id,
            "decision-wrapper-ready",
            captured["contentSha256"],
            "ready",
            None,
            [],
            "policy-1",
            "ready",
        )

        first = await self.registry.deliver(
            message_id,
            "attempt-1",
            captured["contentSha256"],
        )
        second = await self.registry.deliver(
            message_id,
            "attempt-2",
            captured["contentSha256"],
        )

        self.assertTrue(first["accepted"])
        self.assertFalse(first["deduped"])
        self.assertTrue(second["deduped"])
        self.assertEqual(len(self.adapter.native_calls), 1)

    async def test_registry_cannot_deliver_before_policy_decision(self) -> None:
        attach_adapter(
            self.adapter,
            self.registry,
            adapter_id="weixin",
            channel="weixin",
        )
        sent = await self.adapter.send(
            "chat-1",
            "hello",
            metadata={"butler_session_id": "s1"},
        )
        message_id = sent.message_id.removeprefix("butler:")
        captured = self.outbox.get(message_id)

        with self.assertRaisesRegex(ValueError, "not deliverable"):
            await self.registry.deliver(
                message_id,
                "attempt-before-policy",
                captured["contentSha256"],
            )

        self.assertEqual(self.adapter.native_calls, [])

    async def test_send_inherits_run_correlation_from_context(self) -> None:
        attach_adapter(
            self.adapter,
            self.registry,
            adapter_id="weixin:default",
            channel="weixin",
        )

        with message_context(
            session_id="session-context",
            run_id="run-context",
            inbound_message_id="inbound-context",
            message_kind="failure",
            priority="urgent",
        ):
            await self.adapter.send("chat-1", "failed")

        row = self.outbox.list_changes(0, 10)["items"][0]
        self.assertEqual(row["sessionId"], "session-context")
        self.assertEqual(row["runId"], "run-context")
        self.assertEqual(row["inboundMessageId"], "inbound-context")
        self.assertEqual(row["messageKind"], "failure")
        self.assertEqual(row["priority"], "urgent")

    async def test_explicit_attachment_is_spooled_before_capture(self) -> None:
        attach_adapter(
            self.adapter,
            self.registry,
            adapter_id="weixin:default",
            channel="weixin",
        )
        source = Path(self.tmp.name) / "temporary.txt"
        source.write_text("attachment", encoding="utf-8")

        result = await self.adapter.send(
            "chat-1",
            "see attachment",
            metadata={
                "butler_session_id": "session-attachment",
                "butler_attachments": [str(source)],
            },
        )
        source.unlink()

        message_id = result.message_id.removeprefix("butler:")
        attachment = self.outbox.attachments_for(message_id, include_paths=True)[0]
        self.assertEqual(Path(attachment["spoolPath"]).read_text(encoding="utf-8"), "attachment")


if __name__ == "__main__":
    unittest.main()
