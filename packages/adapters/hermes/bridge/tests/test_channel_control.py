"""通道目录与运行态聚合。"""
import json
import tempfile
import unittest
from pathlib import Path

import yaml

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
            "platforms:\n  weixin:\n    enabled: true\n    dm_policy: open\n  feishu:\n    enabled: false\n    extra:\n      app_id: cli_x\n      app_secret: sec\n",
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


class EffectiveEnabledTests(unittest.TestCase):
    """_is_enabled 的「有效启用」语义：enabled 键 + ~/.hermes/.env env 强制启用。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.control = ChannelControl(self.home)

    def tearDown(self):
        self.tmp.cleanup()

    def test_env_forced_weixin_reports_enabled(self):
        (self.home / ".env").write_text("WEIXIN_TOKEN=redacted\n", encoding="utf-8")
        self.assertTrue(self.control.env_forces_enabled("weixin"))
        self.assertTrue(self.control._is_enabled("weixin", {}))

    def test_env_force_overrides_explicit_disabled(self):
        (self.home / ".env").write_text("QQ_APP_ID=123456\n", encoding="utf-8")
        self.assertTrue(self.control._is_enabled("qqbot", {"enabled": False}))

    def test_enabled_absent_without_env_is_disabled(self):
        # Hermes PlatformConfig.enabled 缺省 False，无 env 强制时缺省即停用。
        self.assertFalse(self.control._is_enabled("weixin", {"dm_policy": "open"}))
        self.assertFalse(self.control.env_forces_enabled("weixin"))

    def test_empty_env_value_does_not_force(self):
        (self.home / ".env").write_text("YUANBAO_APP_SECRET=\n", encoding="utf-8")
        self.assertFalse(self.control.env_forces_enabled("yuanbao"))
        self.assertFalse(self.control._is_enabled("yuanbao", {}))

    def test_qqbot_and_yuanbao_env_keys_force_enabled(self):
        (self.home / ".env").write_text("QQ_CLIENT_SECRET=redacted\nYUANBAO_APP_ID=redacted\n", encoding="utf-8")
        self.assertTrue(self.control.env_forces_enabled("qqbot"))
        self.assertTrue(self.control.env_forces_enabled("yuanbao"))

    def test_plugin_channels_have_no_env_force_keys(self):
        for channel in ("feishu", "dingtalk", "wecom"):
            self.assertFalse(self.control.env_forces_enabled(channel))


class ChannelConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / "config.yaml").write_text(
            "gateway:\n  loop_watchdog: true\nplatforms:\n  feishu:\n    enabled: false\n",
            encoding="utf-8",
        )
        self.control = ChannelControl(self.home)

    def tearDown(self):
        self.tmp.cleanup()

    def _platforms(self):
        data = yaml.safe_load((self.home / "config.yaml").read_text(encoding="utf-8"))
        return data["platforms"]

    def test_schema_masks_secret_fields(self):
        view = self.control.schema("feishu")
        self.assertEqual(view["channel"], "feishu")
        self.assertTrue(any(f["name"] == "app_secret" and f["secret"] for f in view["fields"]))

    def test_unknown_channel_rejected(self):
        with self.assertRaises(ValueError):
            self.control.schema("telegram")

    def test_update_config_writes_whitelist_and_backs_up(self):
        saved = self.control.update_config("feishu", {"app_id": "cli_a", "app_secret": "s3cret"})
        self.assertEqual(saved["app_id"], "cli_a")
        self.assertEqual(saved["app_secret"], "••••")
        platforms = self._platforms()
        self.assertEqual(platforms["feishu"]["extra"]["app_id"], "cli_a")
        self.assertEqual(platforms["feishu"]["extra"]["app_secret"], "s3cret")
        # 其他配置节不受影响
        data = yaml.safe_load((self.home / "config.yaml").read_text(encoding="utf-8"))
        self.assertTrue(data["gateway"]["loop_watchdog"])
        backups = list(self.home.glob("config.yaml.bak-butler-*"))
        self.assertEqual(len(backups), 1)

    def test_update_config_rejects_unknown_field(self):
        with self.assertRaises(ValueError):
            self.control.update_config("feishu", {"root_password": "x"})

    def test_update_config_requires_required_fields(self):
        with self.assertRaises(ValueError):
            self.control.update_config("dingtalk", {"client_id": "x"})  # 缺 client_secret

    def test_enable_disable_roundtrip_keeps_credentials(self):
        self.control.update_config("dingtalk", {"client_id": "c1", "client_secret": "s1"})
        self.control.set_enabled("dingtalk", True)
        self.assertTrue(self._platforms()["dingtalk"]["enabled"] is True)
        self.control.set_enabled("dingtalk", False)
        self.assertTrue(self._platforms()["dingtalk"]["enabled"] is False)
        # 凭据保留
        self.assertEqual(self._platforms()["dingtalk"]["extra"]["client_id"], "c1")

    def test_set_enabled_writes_enabled_key_and_clears_disabled_for_core_channels(self):
        # 核心通道（weixin/qqbot/yuanbao）与插件通道统一写 enabled 布尔；
        # 历史遗留的 disabled 键（Hermes 不识别）必须清除，extra 凭据保留。
        (self.home / "config.yaml").write_text(
            "platforms:\n  qqbot:\n    disabled: true\n    extra:\n      app_id: a\n      client_secret: s\n",
            encoding="utf-8",
        )
        self.control.set_enabled("qqbot", True)
        section = self._platforms()["qqbot"]
        self.assertIs(section["enabled"], True)
        self.assertNotIn("disabled", section)
        self.assertEqual(section["extra"]["client_secret"], "s")
        self.control.set_enabled("qqbot", False)
        section = self._platforms()["qqbot"]
        self.assertIs(section["enabled"], False)
        self.assertNotIn("disabled", section)

    def test_disable_env_forced_channel_returns_warning(self):
        (self.home / ".env").write_text("WEIXIN_ACCOUNT_ID=wx123\n", encoding="utf-8")
        result = self.control.set_enabled("weixin", False)
        self.assertIs(result["enabled"], False)
        self.assertEqual(result["channel"], "weixin")
        self.assertIn("warning", result)
        self.assertIn("WEIXIN_ACCOUNT_ID", result["warning"])
        self.assertNotIn("wx123", result["warning"])  # 绝不回显变量值
        # enable 不带 warning；未被 env 强制的通道 disable 也不带
        self.assertNotIn("warning", self.control.set_enabled("weixin", True))
        self.assertNotIn("warning", self.control.set_enabled("feishu", False))

    def test_qqbot_yuanbao_schema_fields_match_hermes(self):
        qq = {f["name"]: f for f in CHANNEL_SCHEMAS["qqbot"]["fields"]}
        self.assertEqual(set(qq), {"app_id", "client_secret"})
        self.assertTrue(qq["client_secret"]["secret"] and qq["client_secret"]["required"])
        self.assertFalse(qq["app_id"]["secret"])
        yb = {f["name"]: f for f in CHANNEL_SCHEMAS["yuanbao"]["fields"]}
        self.assertEqual(set(yb), {"app_id", "app_secret", "bot_id"})
        self.assertTrue(yb["app_secret"]["secret"] and yb["app_secret"]["required"])
        self.assertTrue(yb["app_id"]["required"] and not yb["app_id"]["secret"])
        self.assertFalse(yb["bot_id"]["required"] and not yb["bot_id"]["secret"])

    def test_request_restart_invokes_runner_once(self):
        class _Runner:
            def __init__(self):
                self.calls = 0

            def request_restart(self, **kwargs):
                self.calls += 1
                return True

        class _Binding:
            def __init__(self, runner):
                self.adapter = type("A", (), {"gateway_runner": runner})()

        runner = _Runner()
        registry = _Registry([_Binding(runner)])
        self.assertTrue(self.control.request_restart(registry))
        self.assertEqual(runner.calls, 1)

    def test_request_restart_without_runner_returns_false(self):
        registry = _Registry([])
        self.assertFalse(self.control.request_restart(registry))


if __name__ == "__main__":
    unittest.main()
