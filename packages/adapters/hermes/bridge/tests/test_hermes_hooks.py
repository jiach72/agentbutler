import asyncio
import hashlib
import json
import tempfile
import threading
import unittest
from concurrent.futures import Future
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from agent_butler_bridge.hermes_hooks import (
    attach_runtime_adapter,
    install_a2a_hooks,
    install_api_server_hooks,
    install_base_platform_hooks,
    install_gateway_runtime_hooks,
)
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
        coverage = self.runtime.coverage_snapshot()
        self.assertEqual(coverage["queuedSend"], "ok")
        self.assertEqual(coverage["edit"], "degraded")
        self.assertEqual(coverage["media"], "ok")
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

    async def test_managed_gateway_hooks_correlate_progress_failure_and_final(self) -> None:
        runtime = self.runtime

        class FakeTurnRunner:
            def __init__(self, runner, context) -> None:
                self._runner = runner
                self._ctx = context
                self.original_progress_calls = 0

            def progress_callback(
                self,
                event_type,
                tool_name=None,
                preview=None,
                args=None,
                **kwargs,
            ):
                self.original_progress_calls += 1

        class FakeGatewayRunner:
            def __init__(self) -> None:
                self._agent_butler_runtime = runtime

            async def start(self):
                return True

            async def stop(self):
                return None

            async def _connect_adapter_with_timeout(self, adapter, platform, **kwargs):
                return True

            def _active_profile_name(self):
                return "default"

            async def _run_agent_inner(self, *args, **kwargs):
                turn = FakeTurnRunner(
                    self,
                    SimpleNamespace(session_key=kwargs["session_key"]),
                )
                turn.progress_callback(
                    "tool.completed",
                    tool_name="shell",
                    preview="pytest",
                    duration=1.25,
                )
                return {"failed": True, "final_response": "failed"}

        class FakeBaseAdapter(ChatAdapter):
            def __init__(self) -> None:
                super().__init__()
                self.gateway_runner = FakeGatewayRunner()

            async def handle_message(self, event):
                await self._process_message_background(event, "session-managed")

            async def _process_message_background(self, event, session_key):
                await self.gateway_runner._run_agent_inner(
                    "work",
                    "",
                    [],
                    event.source,
                    session_key,
                    session_key=session_key,
                )
                await self.send(
                    event.source.chat_id,
                    "run failed",
                    metadata={"notify": True},
                )

        install_gateway_runtime_hooks(
            FakeGatewayRunner,
            FakeTurnRunner,
            runtime_provider=lambda: runtime,
        )
        install_base_platform_hooks(FakeBaseAdapter, runtime_provider=lambda: runtime)
        adapter = FakeBaseAdapter()
        attach_runtime_adapter(adapter, "weixin", runtime=runtime)
        event = SimpleNamespace(
            text="do work",
            message_id="platform-1",
            message_type=SimpleNamespace(value="text"),
            user_id="user-1",
            media_urls=[],
            metadata={},
            source=SimpleNamespace(
                platform=SimpleNamespace(value="weixin"),
                chat_id="chat-1",
                thread_id=None,
                user_id="user-1",
            ),
        )

        await adapter.handle_message(event)

        assert runtime.outbox is not None
        batch = runtime.outbox.list_changes(0, 100)
        self.assertEqual(len(batch["items"]), 1)
        outbound = batch["items"][0]
        self.assertEqual(outbound["messageKind"], "failure")
        self.assertEqual(outbound["priority"], "urgent")
        self.assertEqual(outbound["inboundMessageId"], "weixin:default:account-1:platform-1")
        view = runtime.outbox.task_view(outbound["runId"])
        self.assertEqual(view["state"], "failed")
        self.assertEqual(
            [item["kind"] for item in view["events"]],
            ["started", "progress", "completing", "failed"],
        )
        self.assertEqual(view["events"][1]["summary"], "tool.completed · shell · pytest · 1.25s")

        duplicate = SimpleNamespace(
            text="do work",
            message_id="platform-1",
            message_type=SimpleNamespace(value="text"),
            user_id="user-1",
            media_urls=[],
            metadata={},
            source=event.source,
        )
        await adapter.handle_message(duplicate)
        repeated = runtime.outbox.list_changes(0, 100)
        self.assertEqual(len(repeated["items"]), 1)
        self.assertEqual(len(repeated["inbound"]), 1)

    async def test_gateway_runtime_hooks_own_lifecycle_and_attach_connected_profile(self) -> None:
        runtime = self.runtime
        lifecycle_calls = []

        async def start_runtime():
            lifecycle_calls.append("runtime-start")
            return runtime

        async def stop_runtime():
            lifecycle_calls.append("runtime-stop")

        class Turn:
            def progress_callback(self, *args, **kwargs):
                return None

        class Runner:
            def __init__(self) -> None:
                self.calls = []

            async def start(self):
                self.calls.append("gateway-start")
                return True

            async def stop(self):
                self.calls.append("gateway-stop")

            async def _connect_adapter_with_timeout(self, adapter, platform, **kwargs):
                self.calls.append(("connect", platform))
                return True

            async def _run_agent_inner(self, *args, **kwargs):
                return {"final_response": "ok"}

            def _active_profile_name(self):
                return "default"

        install_gateway_runtime_hooks(
            Runner,
            Turn,
            runtime_provider=lambda: runtime,
            runtime_starter=start_runtime,
            runtime_stopper=stop_runtime,
        )
        runner = Runner()
        adapter = ChatAdapter("wx-work")
        adapter._owner_profile = "work"

        self.assertTrue(await runner.start())
        self.assertTrue(await runner._connect_adapter_with_timeout(adapter, "weixin"))
        await runner.stop()

        assert runtime.registry is not None
        self.assertEqual(
            runtime.registry.binding_for(adapter).adapter_id,
            "weixin:work:wx-work",
        )
        self.assertEqual(lifecycle_calls, ["runtime-start", "runtime-stop"])
        self.assertEqual(runner.calls, ["gateway-start", ("connect", "weixin"), "gateway-stop"])
        self.assertIsNone(runner._agent_butler_runtime)

    async def test_api_hook_captures_json_and_sse_once_without_send(self) -> None:
        runtime = self.runtime
        self.install_inline_policy()

        class ManagedApiAdapter(ApiServerAdapter):
            async def _run_agent(
                self,
                user_message,
                conversation_history,
                session_id=None,
                stream_delta_callback=None,
                tool_progress_callback=None,
                gateway_session_key=None,
                **kwargs,
            ):
                if callable(tool_progress_callback):
                    tool_progress_callback(
                        "tool.started",
                        tool_name="search",
                        preview="docs",
                    )
                return ({"final_response": f"answer:{user_message}"}, {"total_tokens": 3})

        install_api_server_hooks(ManagedApiAdapter, runtime_provider=lambda: runtime)
        adapter = ManagedApiAdapter()
        attach_runtime_adapter(adapter, "api_server", runtime=runtime)

        await adapter._run_agent("json", [], session_id="api-json")
        await adapter._run_agent(
            "stream",
            [],
            session_id="api-sse",
            stream_delta_callback=lambda _delta: None,
        )

        assert runtime.outbox is not None
        batch = runtime.outbox.list_changes(0, 100)
        self.assertEqual(adapter.calls, 0)
        self.assertEqual(len(batch["items"]), 2)
        self.assertEqual([item["state"] for item in batch["items"]], ["delivered", "delivered"])
        self.assertEqual(
            [item["metadata"]["apiSurface"] for item in batch["items"]],
            ["json", "sse"],
        )
        for outbound in batch["items"]:
            view = runtime.outbox.task_view(outbound["runId"])
            self.assertEqual(
                [item["kind"] for item in view["events"]],
                ["started", "progress", "completing", "done"],
            )
        coverage = runtime.coverage_snapshot()
        self.assertEqual(coverage["apiJson"], "ok")
        self.assertEqual(coverage["apiSse"], "ok")

    async def test_a2a_managed_push_reports_failure_and_consumes_config_only_on_success(self) -> None:
        class Tasks:
            def __init__(self) -> None:
                self.config = {
                    "configId": "cfg-1",
                    "pushNotificationConfig": {"url": "https://callback.example/push"},
                }
                self.deleted = False

            def get_push_config(self, task_id):
                return None if self.deleted else self.config

            def delete_push_config(self, task_id, config_id=""):
                self.deleted = True
                return True

        class FakeA2A:
            def __init__(self) -> None:
                self.tasks = Tasks()

            def _send_push_notification(self, task_id, context_id, reply, state):
                return None

        metrics = SimpleNamespace(push_failed=0, push_sent=0)
        fake_protocol = SimpleNamespace(
            metrics=metrics,
            status_update=lambda task, context, state, content: {
                "task": task,
                "context": context,
                "state": state,
                "content": content,
            },
        )
        fake_security = SimpleNamespace(
            is_safe_callback_url=lambda _url: True,
            sign_push_payload=lambda _payload: "signature",
        )

        class Response:
            status = 204

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        request_api = SimpleNamespace(
            Request=lambda *args, **kwargs: (args, kwargs),
            urlopen=lambda _request, timeout=10: Response(),
        )
        globals_dict = FakeA2A._send_push_notification.__globals__
        with mock.patch.dict(
            globals_dict,
            {
                "protocol": fake_protocol,
                "security": fake_security,
                "urllib": SimpleNamespace(request=request_api),
                "logger": SimpleNamespace(warning=lambda *args, **kwargs: None),
            },
        ):
            install_a2a_hooks(FakeA2A)
            adapter = FakeA2A()
            result = await adapter.butler_deliver_push(
                "task-1", "ctx-1", "done", {"a2a_state": "completed"}
            )

        self.assertTrue(result.success)
        self.assertTrue(adapter.tasks.deleted)
        self.assertEqual(metrics.push_sent, 1)

        class FailingA2A:
            def __init__(self) -> None:
                self.tasks = Tasks()

            def _send_push_notification(self, task_id, context_id, reply, state):
                return None

        failing_request_api = SimpleNamespace(
            Request=lambda *args, **kwargs: (args, kwargs),
            urlopen=lambda _request, timeout=10: (_ for _ in ()).throw(OSError("offline")),
        )
        with mock.patch.dict(
            FailingA2A._send_push_notification.__globals__,
            {
                "protocol": fake_protocol,
                "security": fake_security,
                "urllib": SimpleNamespace(request=failing_request_api),
                "logger": SimpleNamespace(warning=lambda *args, **kwargs: None),
            },
        ):
            install_a2a_hooks(FailingA2A)
            failing = FailingA2A()
            result = await failing.butler_deliver_push("task-2", "ctx-2", "done", {})

        self.assertFalse(result.success)
        self.assertFalse(failing.tasks.deleted)
        self.assertEqual(result.error, "offline")

        class RoutedA2A:
            def __init__(self) -> None:
                self.tasks = Tasks()
                self._loop = asyncio.get_running_loop()
                self.captured = []

            def _send_push_notification(self, task_id, context_id, reply, state):
                raise AssertionError("native callback path must be replaced")

            async def send(self, chat_id, content, reply_to=None, metadata=None):
                self.captured.append((chat_id, content, reply_to, metadata))
                return FakeSendResult(success=True, message_id="butler:queued")

        install_a2a_hooks(RoutedA2A)
        routed = RoutedA2A()
        routed._send_push_notification("task-3", "ctx-3", "queued", "completed")
        await asyncio.sleep(0)
        self.assertEqual(
            routed.captured,
            [
                (
                    "ctx-3",
                    "queued",
                    "task-3",
                    {"notify": True, "a2a_state": "completed"},
                )
            ],
        )


if __name__ == "__main__":
    unittest.main()
