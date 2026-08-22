"""Instance-level Hermes adapter wrappers for strict Butler capture."""

from __future__ import annotations

import asyncio
import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping

from .ids import uuid7
from .registry import AdapterBinding, NativeRegistry


CONTROL_KEYS = {
    "butler_account_id",
    "butler_inbound_message_id",
    "butler_message_kind",
    "butler_priority",
    "butler_run_id",
    "butler_session_id",
    "butler_thread_id",
    "butler_transport",
}
MESSAGE_KINDS = {"final", "task-progress", "failure", "alert", "system", "mutation"}
PRIORITIES = {"urgent", "normal", "low"}
SENSITIVE_KEY_PARTS = ("token", "secret", "password", "authorization")


@dataclass
class CompatSendResult:
    success: bool
    message_id: str | None = None
    error: str | None = None


def _send_result(*, success: bool, message_id: str | None = None, error: str | None = None):
    try:
        from gateway.platforms.base import SendResult

        return SendResult(success=success, message_id=message_id, error=error)
    except ImportError:
        return CompatSendResult(success=success, message_id=message_id, error=error)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _is_sensitive_key(key: str) -> bool:
    normalized = key.casefold()
    return any(part in normalized for part in SENSITIVE_KEY_PARTS)


def _json_safe(value: Any, *, depth: int = 0) -> Any:
    if depth > 8:
        return "<max-depth>"
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Mapping):
        safe: dict[str, Any] = {}
        for raw_key, raw_value in value.items():
            key = str(raw_key)
            if key in CONTROL_KEYS or key.startswith("butler_") or _is_sensitive_key(key):
                continue
            safe[key] = _json_safe(raw_value, depth=depth + 1)
        return safe
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_json_safe(item, depth=depth + 1) for item in value]
    return str(value)


def json_safe_metadata(metadata: Mapping[str, Any]) -> dict[str, Any]:
    safe = _json_safe(metadata)
    assert isinstance(safe, dict)
    return safe


def _control_string(metadata: Mapping[str, Any], key: str, default: str | None = None) -> str | None:
    value = metadata.get(key, default)
    return value if isinstance(value, str) and value else default


def _build_envelope(
    binding: AdapterBinding,
    registry: NativeRegistry,
    *,
    chat_id: Any,
    content: Any,
    reply_to: Any,
    metadata: Mapping[str, Any],
) -> dict[str, Any]:
    text = str(content)
    transport = _control_string(metadata, "butler_transport", binding.default_transport)
    if transport not in {"queued-push", "inline-response"}:
        raise ValueError("invalid butler_transport")
    message_kind = _control_string(metadata, "butler_message_kind", "final")
    if message_kind not in MESSAGE_KINDS:
        raise ValueError("invalid butler_message_kind")
    priority = _control_string(metadata, "butler_priority", "normal")
    if priority not in PRIORITIES:
        raise ValueError("invalid butler_priority")
    message_id = uuid7()
    chat = str(chat_id)
    return {
        "messageId": message_id,
        "instanceId": registry.instance_id,
        "adapterId": binding.adapter_id,
        "channel": binding.channel,
        "accountId": _control_string(metadata, "butler_account_id", binding.account_id),
        "chatId": chat,
        "threadId": _control_string(metadata, "butler_thread_id"),
        "sessionId": _control_string(metadata, "butler_session_id", f"chat:{chat}"),
        "runId": _control_string(metadata, "butler_run_id"),
        "inboundMessageId": _control_string(metadata, "butler_inbound_message_id"),
        "messageKind": message_kind,
        "transport": transport,
        "priority": priority,
        "content": text,
        "contentSha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "replyTo": None if reply_to is None else str(reply_to),
        "metadata": json_safe_metadata(metadata),
        "capturedAt": _utc_now(),
    }


def attach_adapter(
    adapter: Any,
    registry: NativeRegistry,
    *,
    adapter_id: str,
    channel: str,
    account_id: str | None = None,
    default_transport: str = "queued-push",
) -> AdapterBinding:
    existing = registry.binding_for(adapter)
    if existing is not None:
        return existing

    binding = registry.attach(
        adapter,
        adapter_id=adapter_id,
        channel=channel,
        account_id=account_id,
        default_transport=default_transport,
    )

    async def managed_send(chat_id, content, reply_to=None, metadata=None):
        raw_metadata = metadata if isinstance(metadata, Mapping) else {}
        envelope = _build_envelope(
            binding,
            registry,
            chat_id=chat_id,
            content=content,
            reply_to=reply_to,
            metadata=raw_metadata,
        )
        registry.outbox.capture(envelope)

        if envelope["transport"] == "queued-push":
            return _send_result(
                success=True,
                message_id=f"butler:{envelope['messageId']}",
            )

        policy = registry.outbox.get_policy_snapshot()
        if policy is None or policy["payload"].get("inlineResponse") != "allow":
            registry.outbox.apply_decision(
                envelope["messageId"],
                f"inline:{envelope['messageId']}:policy-unavailable",
                envelope["contentSha256"],
                "policy_error",
                None,
                [],
                "unavailable",
                "Agent Butler policy snapshot unavailable",
            )
            return _send_result(
                success=False,
                error="Agent Butler policy snapshot unavailable",
            )

        attempt_id = f"inline:{envelope['messageId']}"
        registry.outbox.begin_delivery(
            envelope["messageId"],
            attempt_id,
            envelope["contentSha256"],
            allow_captured=True,
        )
        try:
            result = await binding.original_send(
                chat_id,
                content,
                reply_to=reply_to,
                metadata=metadata,
            )
        except asyncio.CancelledError as exc:
            registry.outbox.mark_unknown(
                envelope["messageId"], attempt_id, str(exc) or "inline delivery cancelled"
            )
            raise
        except Exception as exc:
            registry.outbox.mark_unknown(envelope["messageId"], attempt_id, str(exc))
            raise
        if bool(getattr(result, "success", False)):
            registry.outbox.finish_delivery(
                envelope["messageId"],
                attempt_id,
                getattr(result, "message_id", None),
            )
        else:
            registry.outbox.mark_retry(
                envelope["messageId"],
                attempt_id,
                str(getattr(result, "error", None) or "native send failed"),
            )
        return result

    adapter.send = managed_send

    if binding.original_edit is not None:

        async def managed_edit(chat_id, message_id, content, *, finalize=False):
            if isinstance(message_id, str) and message_id.startswith("butler:"):
                bridge_message_id = message_id.removeprefix("butler:")
                row = registry.outbox.get(bridge_message_id)
                if row is None:
                    return _send_result(success=False, error="Unknown Butler message id")
                if row["state"] == "delivered" and row["providerMessageId"]:
                    return await binding.original_edit(
                        chat_id,
                        row["providerMessageId"],
                        content,
                        finalize=finalize,
                    )
                try:
                    registry.outbox.update_pending_content(bridge_message_id, str(content))
                except ValueError as exc:
                    return _send_result(success=False, error=str(exc))
                return _send_result(success=True, message_id=message_id)
            return await binding.original_edit(
                chat_id,
                message_id,
                content,
                finalize=finalize,
            )

        adapter.edit_message = managed_edit

    return binding
