"""微信 iLink 扫码登录会话状态机（mock iLink API）。"""
import asyncio
import unittest

from agent_butler_bridge.weixin_login import WeixinLoginManager


class FakeApi:
    def __init__(self):
        self.qr_requests = 0
        self.status_responses = []

    async def fetch_qr(self):
        self.qr_requests += 1
        return {"qrcode": f"tok{self.qr_requests}", "qrcode_img_content": f"https://qr/{self.qr_requests}"}

    async def poll_status(self, qrcode_value):
        return self.status_responses.pop(0)


def make_manager(responses):
    api = FakeApi()
    api.status_responses = list(responses)
    saved = {}
    manager = WeixinLoginManager(api=api, saver=lambda account: saved.update(account), timeout_seconds=300)
    return manager, api, saved


class WeixinLoginTests(unittest.TestCase):
    def test_start_returns_qr(self):
        manager, api, _ = make_manager([])
        ack = asyncio.run(manager.start())
        self.assertTrue(ack["sessionId"])
        self.assertEqual(ack["qrValue"], "tok1")
        self.assertEqual(ack["qrUrl"], "https://qr/1")

    def test_second_start_conflicts(self):
        manager, _, _ = make_manager([])
        asyncio.run(manager.start())
        with self.assertRaises(Exception):
            asyncio.run(manager.start())

    def test_wait_scan_confirm_saves_credentials(self):
        manager, api, saved = make_manager([
            {"status": "wait"},
            {"status": "scaned"},
            {"status": "confirmed", "ilink_bot_id": "wx_88", "bot_token": "t", "baseurl": "https://x", "ilink_user_id": "u"},
        ])
        ack = asyncio.run(manager.start())
        self.assertEqual(asyncio.run(manager.status(ack["sessionId"]))["state"], "wait")
        self.assertEqual(asyncio.run(manager.status(ack["sessionId"]))["state"], "scanned")
        done = asyncio.run(manager.status(ack["sessionId"]))
        self.assertEqual(done["state"], "confirmed")
        self.assertEqual(done["account"], "wx_88")
        self.assertEqual(saved.get("account_id"), "wx_88")

    def test_expired_refreshes_up_to_three(self):
        manager, api, _ = make_manager([
            {"status": "expired"}, {"status": "expired"}, {"status": "expired"},
        ])
        ack = asyncio.run(manager.start())
        states = [asyncio.run(manager.status(ack["sessionId"]))["state"] for _ in range(3)]
        self.assertEqual(states, ["expired_refreshing"] * 3)
        self.assertEqual(api.qr_requests, 4)  # 初始 + 3 次刷新
        fourth = asyncio.run(manager.status(ack["sessionId"]))
        self.assertEqual(fourth["state"], "failed")

    def test_cancel_kills_session(self):
        manager, _, _ = make_manager([])
        ack = asyncio.run(manager.start())
        self.assertTrue(manager.cancel(ack["sessionId"]))
        payload = asyncio.run(manager.status(ack["sessionId"]))
        self.assertEqual(payload["state"], "failed")


if __name__ == "__main__":
    unittest.main()
