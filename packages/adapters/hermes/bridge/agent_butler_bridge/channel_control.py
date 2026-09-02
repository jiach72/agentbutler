"""国内 IM 通道目录、运行态聚合与配置写入/启停/重启（Butler 面板控制面）。"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
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
            {"name": "client_secret", "label": "Client Secret", "type": "string", "required": True, "secret": True},
        ],
    },
    "yuanbao": {
        "label": "腾讯元宝",
        "kind": "credential",
        "fields": [
            {"name": "app_id", "label": "App ID", "type": "string", "required": True, "secret": False},
            {"name": "app_secret", "label": "App Secret", "type": "string", "required": True, "secret": True},
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


# Hermes 侧核心平台存在 env 强制启用块（hermes-agent gateway/config.py）：
# 任一键在 ~/.hermes/.env 中带非空值即无条件 enabled=True（优先于 YAML 显式停用）。
# 只做键存在性检查，绝不读取/输出值。
_ENV_FORCE_KEYS: dict[str, tuple[str, ...]] = {
    "weixin": ("WEIXIN_TOKEN", "WEIXIN_ACCOUNT_ID"),
    "qqbot": ("QQ_APP_ID", "QQ_CLIENT_SECRET"),
    "yuanbao": ("YUANBAO_APP_ID", "YUANBAO_APP_SECRET"),
}


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

    def _is_enabled(self, channel: str, section: dict[str, Any]) -> bool:
        # 「有效启用」= YAML enabled 键（Hermes PlatformConfig.enabled，缺省 False）
        # 或 ~/.hermes/.env 的 env 强制启用（与 Hermes 实际装载行为一致）。
        if section.get("enabled") is True:
            return True
        return self.env_forces_enabled(channel)

    def env_forces_enabled(self, channel: str) -> bool:
        """~/.hermes/.env 是否存在会强制启用该通道的变量（非空值）。"""
        keys = _ENV_FORCE_KEYS.get(channel)
        if not keys:
            return False
        try:
            text = (self.hermes_home / ".env").read_text(encoding="utf-8")
        except OSError:
            return False
        return any(re.search(rf"^{key}=\S", text, re.MULTILINE) for key in keys)

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

    # ---------- schema / 配置写入 / 启停 / 重启 ----------

    def schema(self, channel: str) -> dict[str, Any]:
        base = CHANNEL_SCHEMAS.get(channel)
        if base is None:
            raise ValueError(f"unsupported channel: {channel}")
        return {"channel": channel, "kind": base["kind"], "label": base["label"], "fields": list(base["fields"])}

    def update_config(self, channel: str, values: dict[str, str]) -> dict[str, Any]:
        base = CHANNEL_SCHEMAS.get(channel)
        if base is None:
            raise ValueError(f"unsupported channel: {channel}")
        field_names = {field["name"] for field in base["fields"]}
        unknown = sorted(set(values) - field_names)
        if unknown:
            raise ValueError(f"unsupported fields: {', '.join(unknown)}")
        incoming = {name: str(value).strip() for name, value in values.items()}
        missing = [
            field["name"]
            for field in base["fields"]
            if field["required"] and not incoming.get(field["name"])
        ]
        if missing:
            raise ValueError(f"missing required fields: {', '.join(missing)}")
        self._mutate_platforms(channel, lambda section: self._apply_fields(channel, section, incoming))
        # 掩码视图：只回显本次提供的字段；secret 字段固定掩码，其余原值。
        secret_by_name = {field["name"]: bool(field["secret"]) for field in base["fields"]}
        saved: dict[str, Any] = {}
        for name in (field["name"] for field in base["fields"]):
            value = incoming.get(name)
            if value:
                saved[name] = "••••" if secret_by_name[name] else value
        return saved

    @staticmethod
    def _apply_fields(channel: str, section: dict[str, Any], incoming: dict[str, str]) -> dict[str, Any]:
        extra = section.setdefault("extra", {})
        if not isinstance(extra, dict):
            section["extra"] = extra = {}
        for name, value in incoming.items():
            if value:
                extra[name] = value
        return section

    def set_enabled(self, channel: str, enabled: bool) -> dict[str, Any]:
        base = CHANNEL_SCHEMAS.get(channel)
        if base is None:
            raise ValueError(f"unsupported channel: {channel}")

        def mutate(section: dict[str, Any]) -> dict[str, Any]:
            # Hermes 对所有平台统一认 enabled 布尔（PlatformConfig.enabled，缺省 False），
            # 不识别 disabled 键；历史遗留的 disabled 一并清除。extra 凭据保持不动。
            section.pop("disabled", None)
            section["enabled"] = enabled
            return section

        self._mutate_platforms(channel, mutate)
        result: dict[str, Any] = {"channel": channel, "enabled": enabled}
        if not enabled and self.env_forces_enabled(channel):
            forced = " 或 ".join(_ENV_FORCE_KEYS[channel])
            result["warning"] = (
                f"Hermes 的 ~/.hermes/.env 中 {forced} 会强制启用{base['label']}，"
                "停用将在移除这些变量后才生效"
            )
        return result

    def _mutate_platforms(self, channel: str, mutate) -> None:
        path = self._config_path()
        data: dict[str, Any] = {}
        if path.is_file():
            data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        if not isinstance(data, dict):
            data = {}
        platforms = data.setdefault("platforms", {})
        if not isinstance(platforms, dict):
            raise ValueError("config.yaml platforms must be a mapping")
        if path.is_file():
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            backup = path.with_name(f"config.yaml.bak-butler-{stamp}")
            backup.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
        section = platforms.get(channel)
        section = section if isinstance(section, dict) else {}
        platforms[channel] = mutate(section)
        text = yaml.safe_dump(data, allow_unicode=True, sort_keys=False)
        temp = path.with_name(f".config.yaml.butler-{os.getpid()}.tmp")
        temp.write_text(text, encoding="utf-8")
        os.replace(temp, path)
        return None

    def request_restart(self, registry) -> bool:
        """触发 Hermes 网关优雅重启一次；失败不重试。"""
        if registry is None:
            return False
        for binding in registry.bindings():
            runner = getattr(binding.adapter, "gateway_runner", None)
            request = getattr(runner, "request_restart", None)
            if callable(request):
                try:
                    return bool(request(via_service=True))
                except Exception:
                    return False
        return False
