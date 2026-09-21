"""飞书 Device-Code 扫码登录会话状态机单元测试。"""

import asyncio
import unittest

from agent_butler_bridge.feishu_login import FeishuLoginManager


class FakeFeishuApi:
    def __init__(self):
        self.begin_calls = 0
        self.poll_calls = 0
        self.poll_responses = []

    def begin(self, domain="feishu"):
        self.begin_calls += 1
        return {
            "device_code": f"dev_{self.begin_calls}",
            "verification_uri_complete": f"https://passport.feishu.cn/qr/{self.begin_calls}",
            "user_code": f"code_{self.begin_calls}",
            "interval": 2,
            "expire_in": 300,
        }

    def poll(self, device_code, domain="feishu"):
        self.poll_calls += 1
        return self.poll_responses.pop(0)


def make_feishu_manager(responses):
    api = FakeFeishuApi()
    api.poll_responses = list(responses)
    saved = {}
    manager = FeishuLoginManager(
        api=api,
        saver=lambda creds: saved.update(creds),
        timeout_seconds=300,
        poll_interval_seconds=1.0,
    )
    return manager, api, saved


class FeishuLoginTests(unittest.TestCase):
    def test_start_returns_qr(self):
        manager, api, _ = make_feishu_manager([])
        ack = asyncio.run(manager.start())
        self.assertTrue(ack["sessionId"])
        self.assertIn("https://passport.feishu.cn/qr/1", ack["qrUrl"])
        self.assertIn("from=hermes", ack["qrUrl"])

    def test_second_start_conflicts(self):
        manager, _, _ = make_feishu_manager([])
        asyncio.run(manager.start())
        with self.assertRaises(Exception):
            asyncio.run(manager.start())

    def test_wait_poll_and_confirm(self):
        manager, api, saved = make_feishu_manager([
            {"error": "authorization_pending"},
            {"client_id": "cli_abc", "client_secret": "sec_123"},
        ])
        ack = asyncio.run(manager.start())
        first = asyncio.run(manager.poll_once(ack["sessionId"]))
        self.assertEqual(first["state"], "wait")
        done = asyncio.run(manager.poll_once(ack["sessionId"]))
        self.assertEqual(done["state"], "confirmed")
        self.assertEqual(done["account"], "cli_abc")
        self.assertEqual(saved.get("app_id"), "cli_abc")
        self.assertEqual(saved.get("app_secret"), "sec_123")

    def test_access_denied_fails(self):
        manager, api, _ = make_feishu_manager([
            {"error": "access_denied"},
        ])
        ack = asyncio.run(manager.start())
        failed = asyncio.run(manager.poll_once(ack["sessionId"]))
        self.assertEqual(failed["state"], "failed")
        self.assertEqual(failed["reason"], "access_denied")

    def test_cancel_kills_session(self):
        manager, _, _ = make_feishu_manager([])
        ack = asyncio.run(manager.start())
        self.assertTrue(manager.cancel(ack["sessionId"]))
        self.assertEqual(manager.status(ack["sessionId"])["state"], "failed")


if __name__ == "__main__":
    unittest.main()
