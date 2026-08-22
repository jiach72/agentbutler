"""Narrow integration helpers called by managed Hermes runtime patches."""

from __future__ import annotations

import inspect
import threading
from dataclasses import dataclass
from typing import Any, Mapping

from .registry import AdapterBinding
from .runtime import BridgeRuntime, get_process_runtime
from .wrapper import attach_adapter


CHANNEL_ALIASES = {
    "api_server": "api-server",
    "api-server": "api-server",
    "weixin": "weixin",
    "a2a": "a2a",
}
UNSUPPORTED_DIRECT_MEDIA = ("send_image", "send_animation", "send_multiple_images")


@dataclass
class HookSendResult:
    success: bool
    message_id: str | None = None
    error: str | None = None


def attach_runtime_adapter(
    adapter: Any,
    platform: Any,
    *,
    profile: str = "default",
    runtime: BridgeRuntime | None = None,
) -> AdapterBinding:
    selected_runtime = runtime or get_process_runtime()
    if selected_runtime is None or selected_runtime.registry is None:
        raise RuntimeError("Agent Butler Bridge runtime is not started")
    channel = normalize_channel(platform)
    account_id = _adapter_account_id(adapter)
    adapter_id = ":".join(
        (
            _safe_segment(channel),
            _safe_segment(profile or "default"),
            _safe_segment(account_id or "default"),
        )
    )

    if channel == "api-server":
        binding = selected_runtime.registry.attach(
            adapter,
            adapter_id=adapter_id,
            channel=channel,
            account_id=account_id,
            default_transport="inline-response",
        )
        selected_runtime.record_coverage(f"adapter:{adapter_id}", "ok")
        selected_runtime.record_coverage("apiServerFinalizer", "pending")
        return binding

    if channel == "a2a":
        push_hook = getattr(adapter, "butler_deliver_push", None)
        binding = attach_adapter(
            adapter,
            selected_runtime.registry,
            adapter_id=adapter_id,
            channel=channel,
            account_id=account_id,
            default_transport="queued-push",
            transport_resolver=lambda chat_id, _content, _reply_to, _metadata: (
                "inline-response" if a2a_has_waiter(adapter, chat_id) else "queued-push"
            ),
            capture_filter=lambda _chat_id, _content, _reply_to, metadata: bool(
                metadata.get("notify")
            ),
            delivery_override=lambda row: _deliver_a2a_push(adapter, row),
            wrap_media=False,
        )
        selected_runtime.record_coverage(f"adapter:{adapter_id}", "ok")
        selected_runtime.record_coverage("a2aWaiter", "ok")
        selected_runtime.record_coverage(
            "a2aPush", "ok" if callable(push_hook) else "degraded"
        )
        return binding

    binding = attach_adapter(
        adapter,
        selected_runtime.registry,
        adapter_id=adapter_id,
        channel=channel,
        account_id=account_id,
        default_transport="queued-push",
        wrap_media=True,
    )
    selected_runtime.record_coverage(f"adapter:{adapter_id}", "ok")
    unsupported = [
        name for name in UNSUPPORTED_DIRECT_MEDIA if callable(getattr(adapter, name, None))
    ]
    selected_runtime.record_coverage(
        f"mediaDirect:{adapter_id}", "degraded" if unsupported else "ok"
    )
    return binding


def normalize_channel(platform: Any) -> str:
    value = getattr(platform, "value", platform)
    if not isinstance(value, str) or not value.strip():
        raise ValueError("platform must identify a non-empty channel")
    normalized = value.strip().casefold()
    return CHANNEL_ALIASES.get(normalized, normalized.replace("_", "-"))


def a2a_has_waiter(adapter: Any, context_id: str) -> bool:
    pending = getattr(adapter, "_pending", None)
    order = getattr(adapter, "_pending_order", None)
    lock = getattr(adapter, "_pending_lock", None)
    if not isinstance(pending, dict) or not isinstance(order, dict):
        return False

    def inspect_waiters() -> bool:
        for task_id in order.get(context_id, ()):
            entry = pending.get(task_id)
            if not isinstance(entry, tuple) or len(entry) < 2:
                continue
            future = entry[1]
            done = getattr(future, "done", None)
            if callable(done) and not done():
                return True
        return False

    if hasattr(lock, "__enter__") and hasattr(lock, "__exit__"):
        with lock:
            return inspect_waiters()
    return inspect_waiters()


async def _deliver_a2a_push(adapter: Any, row: dict[str, Any]) -> Any:
    hook = getattr(adapter, "butler_deliver_push", None)
    if not callable(hook):
        return HookSendResult(
            success=False,
            error="A2A proactive push hook is unavailable",
        )
    task_id = row.get("replyTo")
    if not isinstance(task_id, str) or not task_id:
        return HookSendResult(
            success=False,
            error="A2A proactive push requires the source task id",
        )
    result = hook(task_id, row["chatId"], row["content"], row["metadata"])
    return await result if inspect.isawaitable(result) else result


def _adapter_account_id(adapter: Any) -> str | None:
    for attribute in ("_account_id", "account_id"):
        value = getattr(adapter, attribute, None)
        if isinstance(value, str) and value.strip():
            return value.strip()
    config = getattr(adapter, "config", None)
    extra = getattr(config, "extra", None)
    if isinstance(extra, Mapping):
        for key in ("account_id", "account", "bot_id"):
            value = extra.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def _safe_segment(value: str) -> str:
    cleaned = "".join(
        character if character.isalnum() or character in {"-", "_", "."} else "-"
        for character in value.strip()
    ).strip("-")
    return cleaned[:96] or "default"
