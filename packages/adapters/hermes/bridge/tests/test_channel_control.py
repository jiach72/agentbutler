"""通道目录与运行态聚合。"""
import json
import tempfile
import unittest
from pathlib import Path

from agent_butler_bridge.channel_control import CHANNEL_SCHEMAS, ChannelControl


class _Binding:
    def __init__(self, channel, adapter):
        self.channel = channel
        self.adapter = adapter


class _Registry:
    def __init__(self, bindings):
        self._bindings = bindings

    def bindings(self):
        return list(self._bindings)


class _Adapter:
    def __init__(self, healthy=True):
        self._healthy = healthy

    async def health_probe(self):
        return {"ok": self._healthy}


class ChannelDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / "config.yaml").write_text(
            "platforms:\n  weixin:\n    dm_policy: open\n  feishu:\n    enabled: false\n    extra:\n      app_id: cli_x\n      app_secret: sec\n",
            encoding="utf-8",
        )
        self.control = ChannelControl(self.home)

    def tearDown(self):
        self.tmp.cleanup()

    def test_schemas_cover_six_cn_channels(self):
        self.assertEqual(
            set(CHANNEL_SCHEMAS),
            {"weixin", "qqbot", "yuanbao", "feishu", "dingtalk", "wecom"},
        )
        self.assertEqual(CHANNEL_SCHEMAS["weixin"]["kind"], "qr-login")
        self.assertTrue(all(f["secret"] for f in CHANNEL_SCHEMAS["feishu"]["fields"] if f["name"] in {"app_secret", "verification_token"}))

    def test_directory_reports_configured_and_running(self):
        registry = _Registry([_Binding("weixin", _Adapter())])
        view = self.control.directory(registry)
        by_id = {entry["id"]: entry for entry in view["channels"]}
        self.assertTrue(by_id["weixin"]["enabled"])
        self.assertEqual(by_id["weixin"]["loginState"], "logged_out")
        self.assertFalse(by_id["feishu"]["enabled"])
        self.assertTrue(by_id["feishu"]["credentialsConfigured"])
        self.assertEqual(by_id["feishu"]["kind"], "credential")

    def test_health_status_map_shape(self):
        registry = _Registry([])
        status = self.control.status_map(registry)
        self.assertIn("weixin", status)
        self.assertEqual(status["weixin"]["loginState"], "logged_out")

    def test_weixin_account_file_reports_logged_in(self):
        # 真实结构（hermes weixin.py::_account_dir/_account_file）：
        # ~/.hermes/weixin/accounts/<account_id>.json，account_id 取自文件名。
        accounts = self.home / "weixin" / "accounts"
        accounts.mkdir(parents=True)
        (accounts / "wxid_abc123.json").write_text(
            json.dumps({"token": "t", "base_url": "https://ilink", "user_id": "u", "saved_at": "2026-09-01T00:00:00Z"}),
            encoding="utf-8",
        )
        registry = _Registry([])
        status = self.control.status_map(registry)
        self.assertEqual(status["weixin"]["loginState"], "logged_in")
        self.assertEqual(status["weixin"]["account"], "wxid_abc123")

    def test_weixin_derived_state_files_do_not_count_as_login(self):
        # accounts/ 下还有 <account_id>.context-tokens.json / .sync.json 派生文件，
        # 只有 <account_id>.json 才代表已登录。
        accounts = self.home / "weixin" / "accounts"
        accounts.mkdir(parents=True)
        (accounts / "wxid_x@im.bot.sync.json").write_text("{}", encoding="utf-8")
        (accounts / "wxid_x@im.bot.context-tokens.json").write_text("{}", encoding="utf-8")
        registry = _Registry([])
        status = self.control.status_map(registry)
        self.assertEqual(status["weixin"]["loginState"], "logged_out")


if __name__ == "__main__":
    unittest.main()
