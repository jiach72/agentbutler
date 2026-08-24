import hashlib
import json
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

from agent_butler_bridge.outbox import Outbox
from agent_butler_bridge.registry import NativeRegistry
from agent_butler_bridge.server import create_app
from agent_butler_bridge.wrapper import attach_adapter


TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@dataclass
class FakeSendResult:
    success: bool
    message_id: str | None = None
    error: str | None = None


class FakeAdapter:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        self.calls.append((chat_id, content, reply_to, metadata))
        return FakeSendResult(success=True, message_id="provider-http-1")


def make_envelope(message_id: str) -> dict:
    content = "hello"
    return {
        "messageId": message_id,
        "instanceId": "hermes-main",
        "adapterId": "weixin",
        "channel": "weixin",
        "chatId": "chat-1",
        "sessionId": "session-1",
        "inboundMessageId": "inbound-http-1",
        "messageKind": "final",
        "transport": "queued-push",
        "priority": "normal",
        "content": content,
        "contentSha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
        "metadata": {},
        "capturedAt": "2026-08-22T00:00:00.000Z",
    }


class ServerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.outbox = Outbox(Path(self.tmp.name) / "outbox.sqlite")
        self.registry = NativeRegistry(self.outbox, instance_id="hermes-main")
        self.app = create_app(
            self.outbox,
            self.registry,
            token=TOKEN,
            instance_id="hermes-main",
        )
        self.server = TestServer(self.app)
        self.client = TestClient(self.server)
        await self.client.start_server()

    async def asyncTearDown(self) -> None:
        await self.client.close()
        self.outbox.close()
        self.tmp.cleanup()

    async def test_health_requires_auth_and_reports_protocol(self) -> None:
        denied = await self.client.get("/v1/health")
        self.assertEqual(denied.status, 401)

        ok = await self.client.get("/v1/health", headers=AUTH)

        self.assertEqual(ok.status, 200)
        self.assertEqual(ok.headers["X-Butler-Bridge-Version"], "1")
        body = await ok.json()
        self.assertEqual(body["protocolVersion"], 1)
        self.assertEqual(body["instanceId"], "hermes-main")
        self.assertTrue(body["outboxWritable"])
        self.assertFalse(body["attached"])

    async def test_policy_snapshot_install_enables_health_version(self) -> None:
        payload = {"inlineResponse": "allow"}
        canonical = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        payload_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()

        response = await self.client.post(
            "/v1/policy",
            headers=AUTH,
            json={"version": "policy-1", "sha256": payload_hash, "payload": payload},
        )

        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())["version"], "policy-1")
        health = await self.client.get("/v1/health", headers=AUTH)
        self.assertEqual((await health.json())["policyVersion"], "policy-1")

    async def test_policy_snapshot_rejects_hash_mismatch(self) -> None:
        response = await self.client.post(
            "/v1/policy",
            headers=AUTH,
            json={
                "version": "policy-1",
                "sha256": "wrong",
                "payload": {"inlineResponse": "allow"},
            },
        )

        self.assertEqual(response.status, 409)
        self.assertEqual((await response.json())["error"], "conflict")

    async def test_changes_returns_captured_message(self) -> None:
        envelope = make_envelope("018bcfe5-6800-7000-8000-000000000101")
        self.outbox.capture(envelope)

        response = await self.client.get(
            "/v1/outbox/changes?after=0&limit=10",
            headers=AUTH,
        )

        self.assertEqual(response.status, 200)
        body = await response.json()
        self.assertEqual(body["items"][0]["messageId"], envelope["messageId"])
        self.assertGreater(body["nextSequence"], 0)

    async def test_decision_rejects_hash_mismatch(self) -> None:
        envelope = make_envelope("018bcfe5-6800-7000-8000-000000000102")
        self.outbox.capture(envelope)

        response = await self.client.post(
            f"/v1/outbox/{envelope['messageId']}/decision",
            headers=AUTH,
            json={
                "decisionId": "decision-hash-mismatch",
                "messageId": envelope["messageId"],
                "expectedContentSha256": "wrong",
                "state": "ready",
                "transformTrace": [],
                "policyVersion": "policy-1",
                "reason": "test",
            },
        )

        self.assertEqual(response.status, 409)
        self.assertEqual((await response.json())["error"], "conflict")

    async def test_decision_requires_decision_id(self) -> None:
        envelope = make_envelope("018bcfe5-6800-7000-8000-000000000104")
        self.outbox.capture(envelope)

        response = await self.client.post(
            f"/v1/outbox/{envelope['messageId']}/decision",
            headers=AUTH,
            json={
                "messageId": envelope["messageId"],
                "expectedContentSha256": envelope["contentSha256"],
                "state": "ready",
                "transformTrace": [],
                "policyVersion": "p1",
                "reason": "ready",
            },
        )

        self.assertEqual(response.status, 400)
        self.assertEqual((await response.json())["error"], "invalid")

    async def test_decision_id_collision_returns_conflict(self) -> None:
        first = make_envelope("018bcfe5-6800-7000-8000-000000000105")
        second = make_envelope("018bcfe5-6800-7000-8000-000000000106")
        self.outbox.capture(first)
        self.outbox.capture(second)

        first_response = await self.client.post(
            f"/v1/outbox/{first['messageId']}/decision",
            headers=AUTH,
            json={
                "decisionId": "decision-collision",
                "messageId": first["messageId"],
                "expectedContentSha256": first["contentSha256"],
                "state": "ready",
                "transformTrace": [],
                "policyVersion": "p1",
                "reason": "ready",
            },
        )
        collision = await self.client.post(
            f"/v1/outbox/{second['messageId']}/decision",
            headers=AUTH,
            json={
                "decisionId": "decision-collision",
                "messageId": second["messageId"],
                "expectedContentSha256": second["contentSha256"],
                "state": "ready",
                "transformTrace": [],
                "policyVersion": "p1",
                "reason": "ready",
            },
        )

        self.assertEqual(first_response.status, 200)
        self.assertEqual(collision.status, 409)
        self.assertEqual((await collision.json())["error"], "conflict")

    async def test_decide_then_deliver_calls_native_once(self) -> None:
        adapter = FakeAdapter()
        attach_adapter(
            adapter,
            self.registry,
            adapter_id="weixin",
            channel="weixin",
        )
        captured_result = await adapter.send(
            "chat-1",
            "hello",
            metadata={
                "butler_session_id": "session-1",
                "butler_proactive": True,
            },
        )
        message_id = captured_result.message_id.removeprefix("butler:")
        captured = self.outbox.get(message_id)

        decision = await self.client.post(
            f"/v1/outbox/{message_id}/decision",
            headers=AUTH,
            json={
                "decisionId": "decision-deliver-ready",
                "messageId": message_id,
                "expectedContentSha256": captured["contentSha256"],
                "state": "ready",
                "transformTrace": ["classified:final"],
                "policyVersion": "policy-1",
                "reason": "ready",
            },
        )
        self.assertEqual(decision.status, 200)

        first = await self.client.post(
            "/v1/deliver",
            headers=AUTH,
            json={
                "messageId": message_id,
                "attemptId": "attempt-http-1",
                "expectedContentSha256": captured["contentSha256"],
            },
        )
        second = await self.client.post(
            "/v1/deliver",
            headers=AUTH,
            json={
                "messageId": message_id,
                "attemptId": "attempt-http-2",
                "expectedContentSha256": captured["contentSha256"],
            },
        )

        self.assertEqual(first.status, 200)
        self.assertFalse((await first.json())["deduped"])
        self.assertTrue((await second.json())["deduped"])
        self.assertEqual(len(adapter.calls), 1)

    async def test_decision_replay_returns_transformed_content(self) -> None:
        envelope = make_envelope("018bcfe5-6800-7000-8000-000000000103")
        self.outbox.capture(envelope)
        payload = {
            "decisionId": "decision-http-replay",
            "messageId": envelope["messageId"],
            "expectedContentSha256": envelope["contentSha256"],
            "state": "held_pacing",
            "availableAt": "2026-08-22T10:00:30.000Z",
            "optimizedContent": "digest",
            "transformTrace": ["aggregate-progress"],
            "policyVersion": "p1",
            "reason": "paced",
        }

        first = await self.client.post(
            f"/v1/outbox/{envelope['messageId']}/decision",
            headers=AUTH,
            json=payload,
        )
        replay = await self.client.post(
            f"/v1/outbox/{envelope['messageId']}/decision",
            headers=AUTH,
            json=payload,
        )

        self.assertEqual(first.status, 200)
        self.assertEqual(replay.status, 200)
        self.assertEqual(
            (await replay.json())["contentSha256"],
            (await first.json())["contentSha256"],
        )

    async def test_deliver_rejects_arbitrary_content(self) -> None:
        response = await self.client.post(
            "/v1/deliver",
            headers=AUTH,
            json={
                "messageId": "missing",
                "attemptId": "attempt-1",
                "expectedContentSha256": "hash",
                "content": "must never be accepted",
            },
        )

        self.assertEqual(response.status, 400)
        self.assertEqual((await response.json())["error"], "invalid")

    async def test_prewarm_reports_available_without_adapter_hook(self) -> None:
        # An attached adapter with no warm-up hook is already warm; treating it as
        adapter = FakeAdapter()
        attach_adapter(
            adapter,
            self.registry,
            adapter_id="weixin",
            channel="weixin",
        )
        # unwarmed would deadlock queued-push delivery (reconciler holds indefinitely).
        response = await self.client.post(
            "/v1/prewarm",
            headers=AUTH,
            json={"channel": "weixin"},
        )

        self.assertEqual(response.status, 200)
        body = await response.json()
        self.assertTrue(body["warmed"])
        self.assertIsNotNone(body["expiresAt"])

    async def test_task_route_returns_inbound_event_and_outbound_correlation(self) -> None:
        self.outbox.record_inbound(
            {
                "inboundMessageId": "inbound-http-task",
                "instanceId": "hermes-main",
                "adapterId": "weixin:default",
                "channel": "weixin",
                "chatId": "chat-1",
                "content": "work",
                "receivedAt": "2026-08-22T02:00:00.000Z",
            }
        )
        self.outbox.begin_run(
            session_id="session-http-task",
            inbound_message_id="inbound-http-task",
            run_id="run-http-task",
        )
        envelope = make_envelope("018bcfe5-6800-7000-8000-000000000601")
        envelope["runId"] = "run-http-task"
        envelope["inboundMessageId"] = "inbound-http-task"
        self.outbox.capture(envelope)

        response = await self.client.get("/v1/tasks/run-http-task", headers=AUTH)

        self.assertEqual(response.status, 200)
        body = await response.json()
        self.assertEqual(body["inbound"]["inboundMessageId"], "inbound-http-task")
        self.assertEqual(body["events"][0]["kind"], "started")
        self.assertEqual(body["outbound"][0]["messageId"], envelope["messageId"])

    async def test_dead_letter_route_rejects_delivery_unknown(self) -> None:
        envelope = make_envelope("018bcfe5-6800-7000-8000-000000000602")
        self.outbox.capture(envelope)
        self.outbox.apply_decision(
            envelope["messageId"],
            "decision-http-unknown",
            envelope["contentSha256"],
            "ready",
            None,
            [],
            "policy-1",
            "ready",
        )
        self.outbox.begin_delivery(envelope["messageId"], "attempt-http-unknown", envelope["contentSha256"])
        self.outbox.mark_unknown(envelope["messageId"], "attempt-http-unknown", "timeout")

        response = await self.client.post(
            f"/v1/outbox/{envelope['messageId']}/dead-letter",
            headers=AUTH,
            json={
                "messageId": envelope["messageId"],
                "expectedContentSha256": envelope["contentSha256"],
                "reason": "manual classification",
            },
        )

        self.assertEqual(response.status, 409)
        self.assertIn("delivery_unknown", (await response.json())["detail"])


    async def test_inbound_history_requires_auth_and_returns_decisions(self) -> None:
        denied = await self.client.get("/v1/inbound/history")
        self.assertEqual(denied.status, 401)

        self.outbox.record_inbound(
            {
                "inboundMessageId": "inbound-http-opt",
                "instanceId": "hermes-main",
                "adapterId": "weixin",
                "channel": "weixin",
                "chatId": "chat-1",
                "content": "帮我把那个论文技能弄好点",
                "receivedAt": "2026-08-23T00:00:05.000Z",
            }
        )
        self.outbox.apply_inbound_decision(
            "inbound-http-opt",
            {
                "inboundMessageId": "inbound-http-opt",
                "action": "forward",
                "optimizedText": "改进论文技能",
                "transformTrace": ["optimize:strip-filler"],
                "changes": ["去掉开头的客套话"],
                "mode": "rule",
            },
        )

        response = await self.client.get("/v1/inbound/history?limit=5", headers=AUTH)
        self.assertEqual(response.status, 200)
        body = await response.json()
        self.assertEqual(len(body["items"]), 1)
        self.assertEqual(body["items"][0]["decision"]["mode"], "rule")
        self.assertEqual(body["items"][0]["inbound"]["content"], "帮我把那个论文技能弄好点")

        bad = await self.client.get("/v1/inbound/history?limit=0", headers=AUTH)
        self.assertEqual(bad.status, 400)
        oversized = await self.client.get("/v1/inbound/history?limit=999", headers=AUTH)
        self.assertEqual(oversized.status, 400)

    async def test_inbound_decision_route_accepts_mode_and_changes(self) -> None:
        self.outbox.record_inbound(
            {
                "inboundMessageId": "inbound-http-decision",
                "instanceId": "hermes-main",
                "adapterId": "weixin",
                "channel": "weixin",
                "chatId": "chat-1",
                "content": "/日报",
                "receivedAt": "2026-08-23T00:00:06.000Z",
            }
        )
        response = await self.client.post(
            "/v1/inbound/inbound-http-decision/decision",
            headers=AUTH,
            json={
                "inboundMessageId": "inbound-http-decision",
                "action": "forward",
                "optimizedText": "生成今天的日报并发给我",
                "transformTrace": ["optimize:quick-command"],
                "changes": ["命中快捷指令，展开为完整指令"],
                "mode": "quick",
            },
        )
        self.assertEqual(response.status, 200)
        body = await response.json()
        self.assertEqual(body["mode"], "quick")

        rejected = await self.client.post(
            "/v1/inbound/inbound-http-decision/decision",
            headers=AUTH,
            json={
                "inboundMessageId": "inbound-http-decision",
                "action": "forward",
                "optimizedText": "x",
                "transformTrace": [],
                "mode": "mystery",
            },
        )
        self.assertEqual(rejected.status, 400)


if __name__ == "__main__":
    unittest.main()
