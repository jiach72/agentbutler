"""国内 IM 通道目录与运行态聚合（Butler 面板控制面）。

配置写入/启停/重启触发（update_config/set_enabled/schema/request_restart）
由后续任务补齐；本模块当前只提供目录与每通道运行态视图。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import yaml

# 第一批国内 IM。字段与 Hermes 适配器实际读取的配置键一一对应
# （2026-09-01 自 hermes-agent 提取；适配器变更时回填）。
CHANNEL_SCHEMAS: dict[str, dict[str, Any]] = {
    "weixin": {"label": "微信", "kind": "qr-login", "fields": []},
    "qqbot": {
        "label": "QQ 机器人",
        "kind": "credential",
        "fields": [
            {"name": "app_id", "label": "App ID", "type": "string", "required": True, "secret": False},
            {"name": "app_secret", "label": "App Secret", "type": "string", "required": True, "secret": True},
        ],
    },
    "yuanbao": {
        "label": "腾讯元宝",
        "kind": "credential",
        "fields": [
            {"name": "app_key", "label": "App Key", "type": "string", "required": True, "secret": True},
            {"name": "bot_id", "label": "Bot ID", "type": "string", "required": False, "secret": False},
        ],
    },
    "feishu": {
        "label": "飞书",
        "kind": "credential",
        "fields": [
            {"name": "app_id", "label": "App ID", "type": "string", "required": True, "secret": False},
            {"name": "app_secret", "label": "App Secret", "type": "string", "required": True, "secret": True},
            {"name": "verification_token", "label": "Verification Token", "type": "string", "required": False, "secret": True},
        ],
    },
    "dingtalk": {
        "label": "钉钉",
        "kind": "credential",
        "fields": [
            {"name": "client_id", "label": "Client ID", "type": "string", "required": True, "secret": False},
            {"name": "client_secret", "label": "Client Secret", "type": "string", "required": True, "secret": True},
            {"name": "robot_code", "label": "Robot Code", "type": "string", "required": False, "secret": False},
        ],
    },
    "wecom": {
        "label": "企业微信",
        "kind": "credential",
        "fields": [
            {"name": "bot_id", "label": "Bot ID", "type": "string", "required": True, "secret": False},
            {"name": "secret", "label": "Secret", "type": "string", "required": True, "secret": True},
        ],
    },
}


def default_hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or (Path(os.environ.get("HOME") or Path.home()) / ".hermes"))


class ChannelControl:
    """读取 Hermes config.yaml 的 platforms 子树并聚合通道运行态。"""

    def __init__(self, hermes_home: Path | None = None):
        self.hermes_home = hermes_home or default_hermes_home()

    # ---------- 配置读取 ----------

    def _config_path(self) -> Path:
        return self.hermes_home / "config.yaml"

    def _load_platforms(self) -> dict[str, Any]:
        path = self._config_path()
        if not path.is_file():
            return {}
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        platforms = data.get("platforms") if isinstance(data, dict) else None
        return platforms if isinstance(platforms, dict) else {}

    @staticmethod
    def _credentials_configured(channel: str, section: dict[str, Any]) -> bool:
        schema = CHANNEL_SCHEMAS.get(channel)
        if schema is None or schema["kind"] != "credential":
            return False
        extra = section.get("extra") if isinstance(section.get("extra"), dict) else section
        for field in schema["fields"]:
            if field["required"] and not str(extra.get(field["name"]) or "").strip():
                return False
        return True

    @staticmethod
    def _is_enabled(channel: str, section: dict[str, Any]) -> bool:
        if channel in {"feishu", "dingtalk", "wecom"}:
            return section.get("enabled") is True
        return bool(section) and section.get("disabled") is not True

    def _weixin_login_state(self) -> tuple[str, str | None]:
        # 真实落盘结构（hermes weixin.py::_account_dir/_account_file，及
        # ContextTokenStore/sync 状态写入）：
        #   ~/.hermes/weixin/accounts/<account_id>.json                 账号文件
        #   ~/.hermes/weixin/accounts/<account_id>.context-tokens.json  派生缓存
        #   ~/.hermes/weixin/accounts/<account_id>.sync.json            同步状态
        # account_id 只存在于文件名，不在 JSON 内容里（内容仅
        # token/base_url/user_id/saved_at），因此按后缀排除派生文件。
        accounts_dir = self.hermes_home / "weixin" / "accounts"
        derived_suffixes = (".context-tokens.json", ".sync.json")
        try:
            for account_file in sorted(accounts_dir.glob("*.json")):
                name = account_file.name
                if not account_file.is_file() or name.endswith(derived_suffixes):
                    continue
                account_id = account_file.stem
                if account_id:
                    return "logged_in", account_id
        except Exception:
            return "unknown", None
        return "logged_out", None

    # ---------- 对外视图 ----------

    def _entry(self, channel: str, registry) -> dict[str, Any]:
        schema = CHANNEL_SCHEMAS.get(channel)
        section = self._load_platforms().get(channel)
        section = section if isinstance(section, dict) else {}
        running_channels = {binding.channel for binding in registry.bindings()} if registry is not None else set()
        if channel == "weixin":
            login_state, account = self._weixin_login_state()
        elif self._credentials_configured(channel, section):
            login_state = "logged_in" if channel in running_channels else "logged_out"
            account = str(section.get("app_id") or section.get("client_id") or section.get("bot_id") or "") or None
        else:
            login_state, account = ("configuring", None) if section else ("unknown", None)
        return {
            "id": channel,
            "label": schema["label"] if schema else channel,
            "kind": schema["kind"] if schema else "builtin",
            "enabled": self._is_enabled(channel, section),
            "credentialsConfigured": self._credentials_configured(channel, section),
            "loginState": login_state,
            **({"account": account} if account else {}),
        }

    def directory(self, registry) -> dict[str, Any]:
        channels = list(CHANNEL_SCHEMAS)
        for binding in registry.bindings() if registry is not None else []:
            if binding.channel not in channels:
                channels.append(binding.channel)
        return {"channels": [self._entry(channel, registry) for channel in sorted(channels)]}

    def status_map(self, registry) -> dict[str, Any]:
        return {
            channel: {
                key: value
                for key, value in self._entry(channel, registry).items()
                if key in {"enabled", "credentialsConfigured", "loginState", "account", "lastError"}
            }
            for channel in CHANNEL_SCHEMAS
        }
