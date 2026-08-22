"""Instance-level Hermes adapter wrappers for strict Butler capture."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from .context import (
    current_message_context,
    current_run_failed,
    native_delivery_active,
    native_delivery_scope,
)
from .ids import uuid7
from .registry import AdapterBinding, NativeRegistry
from .registry import CaptureFilter, DeliveryOverride, TransportResolver
from .spool import AttachmentSpool


CONTROL_KEYS = {
    "butler_account_id",
    "butler_attachments",
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
    context = current_message_context()
    text = str(content)
    transport = _control_string(metadata, "butler_transport")
    if transport is None and binding.transport_resolver is not None:
        transport = binding.transport_resolver(chat_id, content, reply_to, metadata)
    transport = transport or context.transport or binding.default_transport
    if transport not in {"queued-push", "inline-response"}:
        raise ValueError("invalid butler_transport")
    default_message_kind = context.message_kind or (
        "failure" if current_run_failed() else "final"
    )
    message_kind = _control_string(
        metadata,
        "butler_message_kind",
        default_message_kind,
    )
    if message_kind not in MESSAGE_KINDS:
        raise ValueError("invalid butler_message_kind")
    default_priority = context.priority or (
        "urgent" if message_kind == "failure" else "normal"
    )
    priority = _control_string(
        metadata,
        "butler_priority",
        default_priority,
    )
    if priority not in PRIORITIES:
        raise ValueError("invalid butler_priority")
    message_id = uuid7()
    chat = str(chat_id)
    return {
        "messageId": message_id,
        "instanceId": registry.instance_id,
        "adapterId": binding.adapter_id,
        "channel": binding.channel,
        "accountId": _control_string(
            metadata,
            "butler_account_id",
            context.account_id or binding.account_id,
        ),
        "chatId": chat,
        "threadId": _control_string(metadata, "butler_thread_id", context.thread_id),
        "sessionId": _control_string(
            metadata,
            "butler_session_id",
            context.session_id or f"chat:{chat}",
        ),
        "runId": _control_string(metadata, "butler_run_id", context.run_id),
        "inboundMessageId": _control_string(
            metadata,
            "butler_inbound_message_id",
            context.inbound_message_id,
        ),
        "messageKind": message_kind,
        "transport": transport,
        "priority": priority,
        "content": text,
        "contentSha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "replyTo": None if reply_to is None else str(reply_to),
        "metadata": json_safe_metadata(metadata),
        "capturedAt": _utc_now(),
    }


def _ensure_completing_before_final_capture(
    registry: NativeRegistry,
    metadata: Mapping[str, Any],
) -> None:
    if not bool(metadata.get("notify")):
        return
    run_id = current_message_context().run_id
    if run_id is None:
        return
    registry.outbox.append_task_event(
        run_id,
        "completing",
        event_key="lifecycle:completing",
    )


def capture_inline_response(
    binding: AdapterBinding,
    registry: NativeRegistry,
    *,
    chat_id: Any,
    content: Any,
    reply_to: Any = None,
    metadata: Mapping[str, Any] | None = None,
    provider_message_id: str | None = None,
) -> dict[str, Any]:
    """Persist one assembled HTTP-style response without calling ``send()``.

    API Server responses are delivered by the surrounding HTTP handler, not by
    the adapter's intentionally unsupported ``send()`` method.  This helper
    gives that path the same capture, policy-snapshot, attempt, and terminal
    accounting as other inline responses while keeping the native send method
    out of the delivery path entirely.
    """

    raw_metadata = metadata if isinstance(metadata, Mapping) else {}
    _ensure_completing_before_final_capture(registry, raw_metadata)
    envelope = _build_envelope(
        binding,
        registry,
        chat_id=chat_id,
        content=content,
        reply_to=reply_to,
        metadata={**raw_metadata, "butler_transport": "inline-response"},
    )
    registry.outbox.capture(envelope)

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
        raise RuntimeError("Agent Butler policy snapshot unavailable")

    attempt_id = f"inline:{envelope['messageId']}"
    registry.outbox.begin_delivery(
        envelope["messageId"],
        attempt_id,
        envelope["contentSha256"],
        allow_captured=True,
    )
    return registry.outbox.finish_delivery(
        envelope["messageId"],
        attempt_id,
        provider_message_id,
    )


def attach_adapter(
    adapter: Any,
    registry: NativeRegistry,
    *,
    adapter_id: str,
    channel: str,
    account_id: str | None = None,
    default_transport: str = "queued-push",
    transport_resolver: TransportResolver | None = None,
    capture_filter: CaptureFilter | None = None,
    delivery_override: DeliveryOverride | None = None,
    wrap_media: bool = True,
) -> AdapterBinding:
    existing = registry.binding_for(adapter)
    if existing is not None:
        if existing.adapter_id != adapter_id or existing.channel != channel:
            raise ValueError("adapter object is already attached with different identity")
        return existing

    binding = registry.attach(
        adapter,
        adapter_id=adapter_id,
        channel=channel,
        account_id=account_id,
        default_transport=default_transport,
        transport_resolver=transport_resolver,
        capture_filter=capture_filter,
        delivery_override=delivery_override,
    )

    async def managed_send(chat_id, content, reply_to=None, metadata=None):
        raw_metadata = metadata if isinstance(metadata, Mapping) else {}
        if native_delivery_active():
            return await binding.original_send(
                chat_id,
                content,
                reply_to=reply_to,
                metadata=metadata,
            )
        if binding.capture_filter is not None and not binding.capture_filter(
            str(chat_id), content, reply_to, raw_metadata
        ):
            return await binding.original_send(
                chat_id,
                content,
                reply_to=reply_to,
                metadata=metadata,
            )
        _ensure_completing_before_final_capture(registry, raw_metadata)
        envelope = _build_envelope(
            binding,
            registry,
            chat_id=chat_id,
            content=content,
            reply_to=reply_to,
            metadata=raw_metadata,
        )
        raw_attachments = raw_metadata.get("butler_attachments")
        spool = AttachmentSpool(registry.outbox.db_path.parent / "spool")
        staged_attachments: list[dict[str, Any]] = []
        if raw_attachments is not None:
            if not isinstance(raw_attachments, (list, tuple)):
                raise ValueError("butler_attachments must be an array")
            if raw_attachments:
                staged_attachments = spool.stage(envelope["messageId"], raw_attachments)
                envelope["attachments"] = staged_attachments
        try:
            registry.outbox.capture(envelope)
        except BaseException:
            if staged_attachments:
                spool.cleanup(envelope["messageId"])
            raise

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
            with native_delivery_scope():
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

    if wrap_media:
        _wrap_media_methods(adapter, binding, registry)

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


MEDIA_PATH_ARGUMENTS = {
    "send_image_file": "image_path",
    "send_document": "file_path",
    "send_video": "video_path",
    "send_voice": "audio_path",
}


def _wrap_media_methods(
    adapter: Any,
    binding: AdapterBinding,
    registry: NativeRegistry,
) -> None:
    for method_name, original in binding.original_media.items():
        path_argument = MEDIA_PATH_ARGUMENTS.get(method_name)
        if path_argument is None:
            continue

        async def managed_media(
            *args,
            _method_name=method_name,
            _original=original,
            _path_argument=path_argument,
            **kwargs,
        ):
            if native_delivery_active():
                return await _original(*args, **kwargs)
            bound = inspect.signature(_original).bind_partial(*args, **kwargs)
            chat_id = bound.arguments.get("chat_id")
            source_path = bound.arguments.get(_path_argument)
            if chat_id is None or not isinstance(source_path, (str, bytes)):
                raise ValueError(f"{_method_name} requires chat_id and {_path_argument}")
            if isinstance(source_path, bytes):
                source_path = source_path.decode("utf-8")
            caption = bound.arguments.get("caption")
            if caption is not None and not isinstance(caption, str):
                caption = str(caption)
            reply_to = bound.arguments.get("reply_to")
            metadata = bound.arguments.get("metadata")
            raw_metadata = metadata if isinstance(metadata, Mapping) else {}
            file_name = bound.arguments.get("file_name")
            if file_name is not None and not isinstance(file_name, str):
                file_name = str(file_name)
            _ensure_completing_before_final_capture(registry, raw_metadata)
            display_content = caption or f"[attachment: {Path(source_path).name}]"
            envelope = _build_envelope(
                binding,
                registry,
                chat_id=chat_id,
                content=display_content,
                reply_to=reply_to,
                metadata=raw_metadata,
            )
            spool = AttachmentSpool(registry.outbox.db_path.parent / "spool")
            staged = spool.stage(envelope["messageId"], [source_path])
            envelope["attachments"] = staged
            envelope["deliveryRoute"] = {
                "kind": "media",
                "method": _method_name,
                "attachmentId": staged[0]["attachmentId"],
                "hasCaption": caption is not None,
                "fileName": file_name,
            }
            try:
                registry.outbox.capture(envelope)
            except BaseException:
                spool.cleanup(envelope["messageId"])
                raise

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
                with native_delivery_scope():
                    result = await _original(*args, **kwargs)
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
                    str(getattr(result, "error", None) or "native media send failed"),
                )
            return result

        setattr(adapter, method_name, managed_media)
