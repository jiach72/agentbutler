"""QQBot Bind-Task 扫码登录会话状态机单元测试。"""

import asyncio
import base64
import os
import unittest

from agent_butler_bridge.qqbot_login import QqbotLoginManager


def _mock_encrypt(plain_text: str, key_base64: str) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    iv = os.urandom(12)
    key = base64.b64decode(key_base64)
    cipher_and_tag = AESGCM(key).encrypt(iv, plain_text.encode("utf-8"), None)
    return base64.b64encode(iv + cipher_and_tag).decode("utf-8")


class FakeQqbotApi:
    def __init__(self):
        self.create_calls = 0
        self.poll_calls = 0
        self.poll_responses = []

    def create_task(self, key: str) -> str:
        self.create_calls += 1
        self.last_key = key
        return f"task_{self.create_calls}"

    def poll_result(self, task_id: str):
        self.poll_calls += 1
        return self.poll_responses.pop(0)


def make_qqbot_manager(responses_fn):
    api = FakeQqbotApi()
    saved = {}
    manager = QqbotLoginManager(
        api=api,
        saver=lambda creds: saved.update(creds),
        timeout_seconds=300,
        poll_interval_seconds=1.0,
    )
    return manager, api, saved


class QqbotLoginTests(unittest.TestCase):
    def test_start_returns_qr(self):
        manager, api, _ = make_qqbot_manager(None)
        ack = asyncio.run(manager.start())
        self.assertTrue(ack["sessionId"])
        self.assertIn("https://q.qq.com/qqbot/openclaw/connect.html?task_id=task_1", ack["qrUrl"])

    def test_second_start_conflicts(self):
        manager, _, _ = make_qqbot_manager(None)
        asyncio.run(manager.start())
        with self.assertRaises(Exception):
            asyncio.run(manager.start())

    def test_wait_poll_and_confirm(self):
        manager, api, saved = make_qqbot_manager(None)
        ack = asyncio.run(manager.start())
        key = manager._sessions[ack["sessionId"]].aes_key

        encrypted = _mock_encrypt("test_secret_xyz", key)
        api.poll_responses = [
            (1, "", "", ""),  # PENDING
            (2, "102030", encrypted, "user_ou123"),  # COMPLETED
        ]

        first = asyncio.run(manager.poll_once(ack["sessionId"]))
        self.assertEqual(first["state"], "wait")
        done = asyncio.run(manager.poll_once(ack["sessionId"]))
        self.assertEqual(done["state"], "confirmed")
        self.assertEqual(done["account"], "102030")
        self.assertEqual(saved.get("app_id"), "102030")
        self.assertEqual(saved.get("client_secret"), "test_secret_xyz")

    def test_expired_refreshes(self):
        manager, api, _ = make_qqbot_manager(None)
        ack = asyncio.run(manager.start())
        api.poll_responses = [
            (3, "", "", ""),  # EXPIRED
        ]
        refresh = asyncio.run(manager.poll_once(ack["sessionId"]))
        self.assertEqual(refresh["state"], "expired_refreshing")
        self.assertEqual(api.create_calls, 2)

    def test_cancel_kills_session(self):
        manager, _, _ = make_qqbot_manager(None)
        ack = asyncio.run(manager.start())
        self.assertTrue(manager.cancel(ack["sessionId"]))
        self.assertEqual(manager.status(ack["sessionId"])["state"], "failed")


if __name__ == "__main__":
    unittest.main()
