"""relayMode passthrough：捕获后立即原生发送，失败落 dead_letter。"""
import asyncio
import unittest
from pathlib import Path

from agent_butler_bridge.context import message_context
from agent_butler_bridge.relay import relay_mode
from agent_butler_bridge.wrapper import attach_adapter


class FakeOutbox:
    def __init__(self, payload=None):
        self.payload = payload
        self.calls = []
        # managed_send 会无条件构造 AttachmentSpool(outbox.db_path.parent / "spool")，
        # 仅访问 .parent，不触发磁盘 IO，故给静态路径即可。
        self.db_path = Path("/tmp/butler-relay-tests/outbox.sqlite")

    def get_policy_snapshot(self):
        if self.payload is None:
            return None
        return {"version": "v1", "sha256": "x", "payload": self.payload}

    def capture(self, envelope):
        self.calls.append(("capture", envelope["messageId"]))

    def begin_delivery(self, message_id, attempt_id, sha, allow_captured=False):
        self.calls.append(("begin", message_id, attempt_id))

    def finish_delivery(self, message_id, attempt_id, provider_message_id):
        self.calls.append(("finish", message_id, provider_message_id))

    def mark_dead_letter(self, message_id, sha, reason, allow_delivering=False):
        self.calls.append(("dead_letter", message_id, reason, allow_delivering))

    def mark_unknown(self, message_id, attempt_id, reason):
        self.calls.append(("unknown", message_id, reason))


class FakeRegistry:
    def __init__(self, outbox):
        self.outbox = outbox
        self.instance_id = "inst"


class FakeAdapter:
    def __init__(self, result):
        self.result = result
        self.send_calls = []

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        self.send_calls.append((chat_id, content))
        return self.result


class FakeBinding:
    def __init__(self, adapter):
        self.adapter = adapter


class SendResult:
    def __init__(self, success=True, message_id=None, error=None):
        self.success = success
        self.message_id = message_id
        self.error = error


def _attached(outbox, adapter):
    registry = FakeRegistry(outbox)
    # attach_adapter 会替换 adapter.send；用真实 registry 流程
    from agent_butler_bridge.registry import NativeRegistry

    real = NativeRegistry(outbox, instance_id="inst")
    attach_adapter(adapter, real, adapter_id="wx", channel="weixin")
    return real, adapter


class RelayModeTests(unittest.TestCase):
    def test_missing_policy_defaults_to_takeover(self):
        self.assertEqual(relay_mode(FakeOutbox(None)), "takeover")

    def test_invalid_value_falls_back_to_takeover(self):
        self.assertEqual(relay_mode(FakeOutbox({"relayMode": "off"})), "takeover")

    def test_passthrough_reads_from_snapshot(self):
        self.assertEqual(relay_mode(FakeOutbox({"relayMode": "passthrough"})), "passthrough")


class PassthroughSendTests(unittest.TestCase):
    def test_passthrough_delivers_native_and_finishes(self):
        outbox = FakeOutbox({"relayMode": "passthrough"})
        adapter = FakeAdapter(SendResult(success=True, message_id="native-1"))
        registry, wrapped = _attached(outbox, adapter)
        with message_context():
            result = asyncio.run(wrapped.send("chat-1", "hello"))
        self.assertTrue(result.success)
        self.assertEqual(result.message_id, "native-1")
        self.assertEqual(len(adapter.send_calls), 1)
        kinds = [call[0] for call in outbox.calls]
        self.assertEqual(kinds, ["capture", "begin", "finish"])

    def test_passthrough_failure_goes_dead_letter(self):
        outbox = FakeOutbox({"relayMode": "passthrough"})
        adapter = FakeAdapter(SendResult(success=False, error="boom"))
        registry, wrapped = _attached(outbox, adapter)
        with message_context():
            result = asyncio.run(wrapped.send("chat-1", "hello"))
        self.assertFalse(result.success)
        self.assertEqual(outbox.calls[-1][0], "dead_letter")
        # 必须显式带 allow_delivering=True，否则真实 Outbox 会拒绝 delivering → dead_letter
        self.assertIs(outbox.calls[-1][3], True)

    def test_takeover_keeps_queued_push_ack(self):
        outbox = FakeOutbox({"relayMode": "takeover"})
        adapter = FakeAdapter(SendResult(success=True))
        registry, wrapped = _attached(outbox, adapter)
        with message_context():
            result = asyncio.run(wrapped.send("chat-1", "hello"))
        self.assertEqual(result.message_id.startswith("butler:"), True)
        self.assertEqual(len(adapter.send_calls), 0)


class PassthroughRealOutboxTests(unittest.TestCase):
    """集成回归：真实 Outbox 状态机下，passthrough 原生发送失败必须落 dead_letter。"""

    def test_failure_dead_letters_real_outbox(self):
        import hashlib
        import json
        import tempfile

        from agent_butler_bridge.outbox import Outbox

        with tempfile.TemporaryDirectory() as tmp:
            outbox = Outbox(Path(tmp) / "outbox.sqlite")
            try:
                payload = {"relayMode": "passthrough"}
                payload_json = json.dumps(
                    payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True
                )
                outbox.set_policy_snapshot(
                    "policy-passthrough",
                    hashlib.sha256(payload_json.encode("utf-8")).hexdigest(),
                    payload,
                )
                adapter = FakeAdapter(SendResult(success=False, error="rate limited"))
                registry, wrapped = _attached(outbox, adapter)
                with message_context(inbound_message_id="inbound-1"):
                    result = asyncio.run(wrapped.send("chat-1", "hello"))

                self.assertFalse(result.success)
                message = outbox.list_changes(0, 10)["items"][0]
                self.assertEqual(message["state"], "dead_letter")
                self.assertIn("rate limited", message["lastError"])
                attempt = outbox._conn.execute(
                    "SELECT finished_at, outcome FROM delivery_attempts WHERE attempt_id = ?",
                    (f"passthrough:{message['messageId']}",),
                ).fetchone()
                self.assertIsNotNone(attempt)
                self.assertIsNotNone(attempt["finished_at"])
                self.assertEqual(attempt["outcome"], "failed")
            finally:
                outbox.close()


class _HookOutbox(FakeOutbox):
    def __init__(self, payload=None):
        super().__init__(payload)
        self.inbounds = {}

    def get_inbound(self, inbound_id):
        return self.inbounds.get(inbound_id)

    def record_inbound(self, envelope):
        self.inbounds[envelope["inboundMessageId"]] = dict(envelope)
        return {"deduped": False}


class _HookRuntime:
    def __init__(self, outbox):
        self.outbox = outbox
        self.config = type("C", (), {"instance_id": "inst", "inbound_optimize": True})()
        self.scheduled = []

    def schedule_inbound_optimization(self, inbound_id, content):
        self.scheduled.append(inbound_id)

    async def wait_inbound_optimization(self, inbound_id):
        self.waited = getattr(self, "waited", 0) + 1


class InboundPassthroughTests(unittest.TestCase):
    def _record(self, runtime, wait):
        from agent_butler_bridge.hermes_hooks import _record_inbound
        from agent_butler_bridge.registry import AdapterBinding

        binding = AdapterBinding(
            adapter=object(),
            adapter_id="wx",
            channel="weixin",
            account_id=None,
            default_transport="queued-push",
            original_send=None,
            original_edit=None,
            original_media={},
            transport_resolver=None,
            capture_filter=None,
            delivery_override=None,
        )
        event = type(
            "E",
            (),
            {"source": None, "message_id": "m1", "text": "hi", "metadata": None, "user_id": "u1"},
        )()
        return asyncio.run(_record_inbound(runtime, binding, event, wait_for_decision=wait))

    def test_passthrough_skips_decision_wait(self):
        from agent_butler_bridge.relay import RELAY_PASSTHROUGH

        outbox = _HookOutbox({"relayMode": RELAY_PASSTHROUGH})
        runtime = _HookRuntime(outbox)
        inbound_id, deduped = self._record(runtime, wait=True)
        self.assertFalse(deduped)
        self.assertEqual(getattr(runtime, "waited", 0), 0)
        self.assertIn(inbound_id, outbox.inbounds)

    def test_takeover_still_waits(self):
        outbox = _HookOutbox({"relayMode": "takeover"})
        runtime = _HookRuntime(outbox)
        self._record(runtime, wait=True)
        self.assertEqual(getattr(runtime, "waited", 0), 1)


if __name__ == "__main__":
    unittest.main()
