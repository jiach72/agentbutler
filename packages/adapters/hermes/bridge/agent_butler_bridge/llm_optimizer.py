"""LLM 入站消息兜底改写器。

设计约束：
- 只在规则优化器判定“原样透传”时使用，避免重复改写；
- 未配置端点 / 短消息 / 请求失败 / 结果不可用时一律返回 None，由调用方保留原文；
- 超时、异常绝不影响消息收发热路径。
"""

from __future__ import annotations

import asyncio
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import aiohttp

MODE_LLM = "llm"
TRACE_LLM_FALLBACK = "optimize:llm-fallback"
CHANGE_AI_REWRITE = "由 AI 改写"

DEFAULT_TIMEOUT_MS = 15000
MAX_INPUT_CHARS = 1200
MAX_OUTPUT_CHARS = 3000
MIN_INPUT_CHARS = 8

_FALSE_VALUES = {"0", "false", "off", "no"}

_SYSTEM_PROMPT = (
    "你是本地 AI 管家的消息整理助手，用户通常不懂技术术语。"
    "请把用户发来的口语消息整理成一条给 AI 的清晰中文指令。要求："
    "1. 保留用户原意和所有关键信息；"
    "2. 把口语、指代、省略的内容补成明确的动作；"
    "3. 不添加原消息没有提出的要求；"
    "4. 如果原消息本身已经清楚或无法理解，就原样返回；"
    "5. 只输出整理后的指令，不要解释、不要加前缀、不要用引号包裹。"
)


@dataclass(frozen=True)
class LlmConfig:
    """LLM 兜底配置；未配置时 enabled=False。"""

    enabled: bool
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    timeout_ms: int = DEFAULT_TIMEOUT_MS
    min_input_chars: int = MIN_INPUT_CHARS
    fallback: "LlmConfig | None" = None

    @classmethod
    def from_env(
        cls,
        env: Mapping[str, str] | None = None,
        config_path: Path | str | None = None,
    ) -> "LlmConfig":
        selected = {str(k): str(v) for k, v in (env if env is not None else os.environ).items()}
        hermes_home = Path(selected.get("HERMES_HOME") or Path.home() / ".hermes")
        env_values = _read_dotenv(hermes_home / ".env")
        discovered = _read_hermes_model_config(config_path or hermes_home / "config.yaml")

        # 显式管家配置 > Hermes 完整自定义 provider > 旧的 DEEPSEEK/OPENAI 配置。
        # 避免把 DeepSeek 的 key 与自定义 provider 的 base_url/model 混用。
        explicit_base = _first_nonempty(
            selected.get("HERMES_BUTLER_LLM_BASE_URL"),
            selected.get("BUTLER_LLM_BASE_URL"),
            env_values.get("HERMES_BUTLER_LLM_BASE_URL"),
            env_values.get("BUTLER_LLM_BASE_URL"),
        )
        explicit_api_key = _first_nonempty(
            selected.get("HERMES_BUTLER_LLM_API_KEY"),
            selected.get("BUTLER_LLM_API_KEY"),
            env_values.get("HERMES_BUTLER_LLM_API_KEY"),
            env_values.get("BUTLER_LLM_API_KEY"),
        )
        explicit_model = _first_nonempty(
            selected.get("HERMES_BUTLER_LLM_MODEL"),
            selected.get("BUTLER_LLM_MODEL"),
            env_values.get("HERMES_BUTLER_LLM_MODEL"),
            env_values.get("BUTLER_LLM_MODEL"),
        )
        legacy_base = _first_nonempty(
            selected.get("DEEPSEEK_BASE_URL"),
            selected.get("OPENAI_BASE_URL"),
            env_values.get("DEEPSEEK_BASE_URL"),
            env_values.get("OPENAI_BASE_URL"),
        )
        legacy_api_key = _first_nonempty(
            selected.get("DEEPSEEK_API_KEY"),
            selected.get("OPENAI_API_KEY"),
            env_values.get("DEEPSEEK_API_KEY"),
            env_values.get("OPENAI_API_KEY"),
        )
        legacy_model = _first_nonempty(
            selected.get("LLM_MODEL"),
            selected.get("DEEPSEEK_MODEL"),
            selected.get("OPENAI_MODEL"),
            env_values.get("LLM_MODEL"),
            env_values.get("DEEPSEEK_MODEL"),
            env_values.get("OPENAI_MODEL"),
        )
        base_url = _first_nonempty(
            explicit_base,
            discovered.get("base_url"),
            legacy_base,
        )
        api_key = _first_nonempty(
            explicit_api_key,
            discovered.get("api_key"),
            legacy_api_key,
        )
        model = _first_nonempty(
            explicit_model,
            discovered.get("model"),
            legacy_model,
        )

        enabled_raw = _first_nonempty(
            selected.get("HERMES_BUTLER_LLM_ENABLED"),
            selected.get("BUTLER_LLM_ENABLED"),
            env_values.get("HERMES_BUTLER_LLM_ENABLED"),
            env_values.get("BUTLER_LLM_ENABLED"),
        )
        enabled = (
            enabled_raw.strip().casefold() not in _FALSE_VALUES
            if enabled_raw is not None and enabled_raw.strip() != ""
            else bool(base_url and api_key and model)
        )
        timeout_raw = selected.get("HERMES_BUTLER_LLM_TIMEOUT_MS")
        timeout_ms = DEFAULT_TIMEOUT_MS
        if timeout_raw is not None and timeout_raw.strip() != "":
            try:
                parsed = int(timeout_raw)
                if parsed > 0:
                    timeout_ms = min(parsed, 30000)
            except ValueError:
                pass
        fallback_config = None
        if discovered.get("fallback_base_url") and discovered.get("fallback_api_key") and discovered.get("fallback_model"):
            fallback_config = cls(
                enabled=True,
                base_url=discovered["fallback_base_url"],
                api_key=discovered["fallback_api_key"],
                model=discovered["fallback_model"],
                timeout_ms=timeout_ms,
            )
        return cls(
            enabled=enabled,
            base_url=base_url,
            api_key=api_key,
            model=model,
            timeout_ms=timeout_ms,
            fallback=fallback_config,
        )


def should_attempt_llm(text: str, config: LlmConfig | None) -> bool:
    """短问候、超长消息或未配置时不调用外部模型。"""
    if config is None or not config.enabled:
        return False
    if not config.base_url or not config.api_key or not config.model:
        return False
    content = text.strip()
    if len(content) < max(1, config.min_input_chars):
        return False
    if len(content) > MAX_INPUT_CHARS:
        return False
    return True


async def optimize_with_llm(text: str, config: LlmConfig | None) -> dict[str, Any] | None:
    """调用 OpenAI-compatible chat/completions；任何失败都返回 None。"""
    result = await _optimize_with_llm_once(text, config)
    if result is None and config is not None and config.fallback is not None:
        result = await _optimize_with_llm_once(text, config.fallback)
    return result


async def _optimize_with_llm_once(
    text: str,
    config: LlmConfig | None,
) -> dict[str, Any] | None:
    """单次调用；主 provider 失败时由外层尝试备用 provider。"""
    if not should_attempt_llm(text, config):
        return None
    assert config is not None
    try:
        output = await asyncio.wait_for(
            _request_chat(text, config),
            timeout=max(1.0, config.timeout_ms / 1000),
        )
    except (asyncio.TimeoutError, aiohttp.ClientError, ValueError, KeyError, TypeError):
        return None
    except Exception:
        # 外部服务异常不允许进入热路径；保持静默降级。
        return None

    cleaned = _clean_output(output)
    if not cleaned or cleaned == text.strip():
        return None
    if len(cleaned) > MAX_OUTPUT_CHARS:
        return None
    if len(cleaned) > len(text.strip()) * 3 + 200:
        return None
    return {
        "mode": MODE_LLM,
        "optimizedText": cleaned,
        "transformTrace": [TRACE_LLM_FALLBACK],
        "changes": [CHANGE_AI_REWRITE],
    }


async def _request_chat(text: str, config: LlmConfig) -> str:
    base = config.base_url.rstrip("/")
    url = f"{base}/chat/completions"
    headers = {
        "content-type": "application/json",
        "authorization": f"Bearer {config.api_key}",
    }
    payload = {
        "model": config.model,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
        "temperature": 0.1,
        "max_tokens": 800,
    }
    if "xiaomimimo.com" in base or config.model.startswith("mimo-"):
        # Xiaomi MiMo 默认会做较长的思考，简单指令整理不需要；关闭后速度明显更快。
        payload["reasoning_effort"] = "none"
    timeout = aiohttp.ClientTimeout(total=config.timeout_ms / 1000)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(url, headers=headers, json=payload) as response:
            if response.status != 200:
                raise ValueError(f"LLM HTTP {response.status}")
            body = await response.json(content_type=None)
    choices = body.get("choices") if isinstance(body, dict) else None
    if not isinstance(choices, list) or not choices:
        raise ValueError("LLM response has no choices")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str):
        raise ValueError("LLM response has no text content")
    return content


def _clean_output(output: str) -> str:
    cleaned = output.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:[a-zA-Z0-9_-]+)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```\s*$", "", cleaned)
    cleaned = re.sub(r"^[\"'“”‘’]+|[\"'“”‘’]+$", "", cleaned)
    cleaned = re.sub(r"[ \t]+", " ", cleaned).strip()
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned


def _first_nonempty(*values: str | None) -> str:
    for value in values:
        if value is not None and value.strip():
            return value.strip()
    return ""


def _provider_candidates(loaded: Mapping[str, Any]) -> list[dict[str, str]]:
    """收集 Hermes 中配置完整、可尝试的 OpenAI-compatible provider。"""
    candidates: list[dict[str, str]] = []
    model_block = loaded.get("model")
    provider_name = ""
    if isinstance(model_block, Mapping):
        provider_name = str(model_block.get("provider") or "").strip()

    custom = loaded.get("custom_providers")
    if isinstance(custom, list):
        for raw in custom:
            if not isinstance(raw, Mapping):
                continue
            candidate = {
                "name": str(raw.get("name") or raw.get("id") or "").strip(),
                "base_url": str(raw.get("base_url") or "").strip(),
                "api_key": str(raw.get("api_key") or "").strip(),
                "model": str(raw.get("model") or raw.get("default") or "").strip(),
            }
            if candidate["base_url"] and candidate["api_key"] and candidate["model"]:
                candidates.append(candidate)

    auxiliary = loaded.get("auxiliary")
    if isinstance(auxiliary, Mapping):
        for section in ("vision", "web_extract"):
            raw = auxiliary.get(section)
            if not isinstance(raw, Mapping):
                continue
            candidate = {
                "name": str(raw.get("provider") or section),
                "base_url": str(raw.get("base_url") or "").strip(),
                "api_key": str(raw.get("api_key") or "").strip(),
                "model": str(raw.get("model") or "").strip(),
            }
            if "xiaomimimo.com" in candidate["base_url"] and candidate["model"].startswith("mimo-v2.5"):
                candidate["model"] = "mimo-v2.5-pro"
            if candidate["base_url"] and candidate["api_key"] and candidate["model"]:
                candidates.append(candidate)

    if isinstance(model_block, Mapping):
        candidate = {
            "name": provider_name,
            "base_url": str(model_block.get("base_url") or "").strip(),
            "api_key": str(model_block.get("api_key") or "").strip(),
            "model": str(model_block.get("default") or model_block.get("model") or "").strip(),
        }
        if candidate["base_url"] and candidate["api_key"] and candidate["model"]:
            candidates.append(candidate)

    unique: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for candidate in candidates:
        key = (candidate["base_url"], candidate["model"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(candidate)

    if provider_name:
        preferred = [
            item
            for item in unique
            if item["name"] == provider_name or item["model"] == provider_name
        ]
        unique = preferred + [item for item in unique if item not in preferred]
    return unique


def _read_hermes_model_config(path: Path | str) -> dict[str, str]:
    path = Path(path)
    if not path.is_file():
        return {}
    try:
        import yaml

        loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            return {}
        candidates = _provider_candidates(loaded)
        if not candidates:
            return {}
        primary = dict(candidates[0])
        if len(candidates) > 1:
            fallback = candidates[1]
            primary["fallback_base_url"] = fallback["base_url"]
            primary["fallback_api_key"] = fallback["api_key"]
            primary["fallback_model"] = fallback["model"]
        return primary
    except Exception:
        return _read_hermes_model_config_fallback(path)


def _read_hermes_model_config_fallback(path: Path | str) -> dict[str, str]:
    path = Path(path)
    in_model = False
    model_base = ""
    model_name = ""
    for raw in path.read_text(encoding="utf-8").splitlines():
        if re.match(r"^model:\s*$", raw):
            in_model = True
            continue
        if in_model and raw and not raw[:1].isspace():
            break
        if not in_model:
            continue
        match = re.match(r"^\s*base_url:\s*(.*)$", raw)
        if match is not None:
            model_base = match.group(1).strip().strip("'\"")
            continue
        match = re.match(r"^\s*(?:default|model):\s*(.*)$", raw)
        if match is not None:
            model_name = match.group(1).strip().strip("'\"")
    return {"base_url": model_base, "model": model_name}


def _read_dotenv(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    values: dict[str, str] = {}
    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip("'\"")
            if key:
                values[key] = value
    except OSError:
        return {}
    return values
