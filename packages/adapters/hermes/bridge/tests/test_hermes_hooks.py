import hashlib
import json
import tempfile
import threading
import unittest
from concurrent.futures import Future
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

from agent_butler_bridge.hermes_hooks import attach_runtime_adapter
from agent_butler_bridge.runtime import BridgeRuntime, RuntimeConfig


@dataclass
class FakeSendResult:
    success: bool
    message_id: str | None = None
    error: str | None = None


class ChatAdapter:
    def __init__(self, account_id: str = "account-1") -> None:
        self._account_id = account_id
        self.config = SimpleNamespace(extra={})
        self.native_calls: list[tuple] = []
        self.document_calls: list[tuple] = []

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        self.native_calls.append((chat_id, content, reply_to, metadata))
        return FakeSendResult(success=True, message_id=f"native-{len(self.native_calls)}")

    async def send_document(
        self,
        chat_id,
        file_path,
        caption=None,
        file_name=None,
        reply_to=None,
        metadata=None,
        **kwargs,
    ):
        self.document_calls.append(
            (
                chat_id,
                Path(file_path).read_bytes(),
                caption,
                file_name,
                reply_to,
                metadata,
            )
        )
        return FakeSendResult(success=True, message_id="native-document-1")


class A2AAdapter:
    def __init__(self, *, push_hook: bool = True) -> None:
        self.config = SimpleNamespace(extra={})
        self._pending: dict[str, tuple[str, Future]] = {}
        self._pending_order: dict[str, list[str]] = {}
        self._pending_lock = threading.Lock()
        self.native_calls: list[tuple] = []
        self.push_calls: list[tuple] = []
        if not push_hook:
            self.butler_deliver_push = None

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        self.native_calls.append((chat_id, content, reply_to, metadata))
        return FakeSendResult(success=True, message_id="a2a-inline-1")

    async def butler_deliver_push(self, task_id, context_id, content, metadata):
        self.push_calls.append((task_id, context_id, content, metadata))
        return FakeSendResult(success=True, message_id="a2a-push-1")

    def add_waiter(self, task_id: str, context_id: str) -> None:
        future: Future = Future()
        self._pending[task_id] = (context_id, future)
        self._pending_order.setdefault(context_id, []).append(task_id)


class ApiServerAdapter:
    def __init__(self) -> None:
        self.config = SimpleNamespace(extra={})
        self.calls = 0

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        self.calls += 1
        return FakeSendResult(success=False, error="HTTP response path")


class HermesHooksTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        token = self.root / "bridge.token"
        token.write_text("hook-test-token", encoding="utf-8")
        token.chmod(0o600)
        self.runtime = BridgeRuntime(
            RuntimeConfig(
                instance_id="hermes-main",
                host="127.0.0.1",
                port=0,
                token_file=token,
                outbox_path=self.root / "data" / "outbox.sqlite",
            )
        )
        await self.runtime.start()

    async def asyncTearDown(self) -> None:
        await self.runtime.stop()
        self.tmp.cleanup()

    def install_inline_policy(self) -> None:
        payload = {"inlineResponse": "allow"}
        payload_hash = hashlib.sha256(
            json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        ).hexdigest()
        assert self.runtime.outbox is not None
        self.runtime.outbox.set_policy_snapshot("policy-1", payload_hash, payload)

    async def test_stable_profile_account_id_and_reconnect_replaces_delivery_binding(self) -> None:
        first = ChatAdapter("wx-main")
        binding = attach_runtime_adapter(first, "weixin", profile="work", runtime=self.runtime)
        duplicate = attach_runtime_adapter(first, "weixin", profile="work", runtime=self.runtime)
        queued = await first.send("chat-1", "hello", metadata={"butler_session_id": "s1"})
        second = ChatAdapter("wx-main")
        replacement = attach_runtime_adapter(second, "weixin", profile="work", runtime=self.runtime)
        personal = ChatAdapter("wx-main")
        personal_binding = attach_runtime_adapter(
            personal, "weixin", profile="personal", runtime=self.runtime
        )

        self.assertIs(duplicate, binding)
        self.assertEqual(binding.adapter_id, "weixin:work:wx-main")
        self.assertEqual(replacement.adapter_id, binding.adapter_id)
        self.assertEqual(personal_binding.adapter_id, "weixin:personal:wx-main")
        assert self.runtime.registry is not None
        self.assertEqual(
            self.runtime.registry.attached_adapter_ids(),
            ["weixin:personal:wx-main", "weixin:work:wx-main"],
        )
        message_id = queued.message_id.removeprefix("butler:")
        assert self.runtime.outbox is not None
        row = self.runtime.outbox.get(message_id)
        self.runtime.outbox.apply_decision(
            message_id,
            "decision-reconnect",
            row["contentSha256"],
            "ready",
            None,
            [],
            "policy-1",
            "ready",
        )

        ack = await self.runtime.registry.deliver(
            message_id, "attempt-reconnect", row["contentSha256"]
        )

        self.assertTrue(ack["accepted"])
        self.assertEqual(first.native_calls, [])
        self.assertEqual(len(second.native_calls), 1)

    async def test_a2a_waiter_is_inline_and_no_waiter_uses_push_override(self) -> None:
        self.install_inline_policy()
        adapter = A2AAdapter()
        attach_runtime_adapter(adapter, "a2a", runtime=self.runtime)
        adapter.add_waiter("task-inline", "ctx-inline")

        inline = await adapter.send(
            "ctx-inline",
            "inline answer",
            reply_to="task-inline",
            metadata={"notify": True, "butler_session_id": "s-inline"},
        )
        queued = await adapter.send(
            "ctx-push",
            "push answer",
            reply_to="task-push",
            metadata={"notify": True, "butler_session_id": "s-push"},
        )

        self.assertEqual(inline.message_id, "a2a-inline-1")
        self.assertTrue(queued.message_id.startswith("butler:"))
        self.assertEqual(len(adapter.native_calls), 1)
        message_id = queued.message_id.removeprefix("butler:")
        assert self.runtime.outbox is not None and self.runtime.registry is not None
        row = self.runtime.outbox.get(message_id)
        self.assertEqual(row["transport"], "queued-push")
        self.runtime.outbox.apply_decision(
            message_id,
            "decision-a2a-push",
            row["contentSha256"],
            "ready",
            None,
            [],
            "policy-1",
            "ready",
        )
        ack = await self.runtime.registry.deliver(
            message_id, "attempt-a2a-push", row["contentSha256"]
        )
        self.assertTrue(ack["accepted"])
        self.assertEqual(adapter.push_calls[0][:3], ("task-push", "ctx-push", "push answer"))

        before = self.runtime.outbox.list_changes(0, 100)["nextSequence"]
        await adapter.send("ctx-progress", "progress", metadata={"notify": False})
        after = self.runtime.outbox.list_changes(before, 100)
        self.assertEqual(after["items"], [])
        self.assertEqual(len(adapter.native_calls), 2)

    async def test_a2a_without_push_hook_stays_degraded_and_fails_explicitly(self) -> None:
        adapter = A2AAdapter(push_hook=False)
        attach_runtime_adapter(adapter, "a2a", runtime=self.runtime)
        queued = await adapter.send(
            "ctx-push",
            "push answer",
            reply_to="task-push",
            metadata={"notify": True, "butler_session_id": "s-push"},
        )
        message_id = queued.message_id.removeprefix("butler:")
        assert self.runtime.outbox is not None and self.runtime.registry is not None
        row = self.runtime.outbox.get(message_id)
        self.runtime.outbox.apply_decision(
            message_id,
            "decision-a2a-missing-hook",
            row["contentSha256"],
            "ready",
            None,
            [],
            "policy-1",
            "ready",
        )

        ack = await self.runtime.registry.deliver(
            message_id, "attempt-a2a-missing-hook", row["contentSha256"]
        )

        self.assertFalse(ack["accepted"])
        self.assertEqual(ack["state"], "retry_wait")
        self.assertEqual(self.runtime.coverage_snapshot()["a2aPush"], "degraded")

    async def test_direct_document_uses_spool_and_native_method_on_delivery(self) -> None:
        adapter = ChatAdapter()
        attach_runtime_adapter(adapter, "weixin", runtime=self.runtime)
        source = self.root / "temporary.txt"
        source.write_text("durable media", encoding="utf-8")

        queued = await adapter.send_document(
            "chat-1",
            str(source),
            caption="report",
            file_name="report.txt",
            reply_to="inbound-1",
            metadata={"butler_session_id": "session-doc"},
        )
        source.unlink()

        self.assertTrue(queued.message_id.startswith("butler:"))
        self.assertEqual(adapter.document_calls, [])
        message_id = queued.message_id.removeprefix("butler:")
        assert self.runtime.outbox is not None and self.runtime.registry is not None
        row = self.runtime.outbox.get(message_id)
        self.assertNotIn("spoolPath", str(row))
        self.runtime.outbox.apply_decision(
            message_id,
            "decision-document",
            row["contentSha256"],
            "ready",
            None,
            [],
            "policy-1",
            "ready",
        )
        ack = await self.runtime.registry.deliver(
            message_id, "attempt-document", row["contentSha256"]
        )

        self.assertTrue(ack["accepted"])
        self.assertEqual(adapter.document_calls[0][1], b"durable media")
        self.assertEqual(adapter.document_calls[0][2:5], ("report", "report.txt", "inbound-1"))

    async def test_api_server_is_registered_without_wrapping_unused_send(self) -> None:
        adapter = ApiServerAdapter()
        original_send = adapter.send

        binding = attach_runtime_adapter(adapter, "api_server", runtime=self.runtime)
        result = await adapter.send("http", "ignored")

        self.assertEqual(binding.channel, "api-server")
        self.assertEqual(adapter.send, original_send)
        self.assertFalse(result.success)
        self.assertEqual(adapter.calls, 1)
        self.assertEqual(self.runtime.coverage_snapshot()["apiServerFinalizer"], "pending")


if __name__ == "__main__":
    unittest.main()
