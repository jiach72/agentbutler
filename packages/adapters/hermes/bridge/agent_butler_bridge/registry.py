"""Registry of original Hermes adapter methods used for managed delivery."""

from __future__ import annotations

import asyncio
import inspect
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Mapping
from weakref import WeakKeyDictionary

from .outbox import Outbox
from .context import native_delivery_scope


SendCallable = Callable[..., Awaitable[Any]]
EditCallable = Callable[..., Awaitable[Any]]
TransportResolver = Callable[[str, Any, Any, Mapping[str, Any]], str]
CaptureFilter = Callable[[str, Any, Any, Mapping[str, Any]], bool]
DeliveryOverride = Callable[[dict[str, Any]], Awaitable[Any] | Any]
MEDIA_METHODS = (
    "send_image",
    "send_animation",
    "send_multiple_images",
    "send_image_file",
    "send_document",
    "send_video",
    "send_voice",
)


@dataclass
class AdapterBinding:
    adapter: Any
    adapter_id: str
    channel: str
    account_id: str | None
    default_transport: str
    original_send: SendCallable
    original_edit: EditCallable | None
    original_media: dict[str, SendCallable]
    transport_resolver: TransportResolver | None
    capture_filter: CaptureFilter | None
    delivery_override: DeliveryOverride | None


@dataclass(frozen=True)
class MediaSendResult:
    success: bool = True
    message_id: str | None = None
    error: str | None = None


class NativeRegistry:
    """Keep native bound methods outside the public Bridge HTTP surface."""

    def __init__(self, outbox: Outbox, *, instance_id: str):
        self.outbox = outbox
        self.instance_id = instance_id
        self._by_instance: WeakKeyDictionary[Any, AdapterBinding] = WeakKeyDictionary()
        self._by_adapter_id: dict[str, AdapterBinding] = {}

    def binding_for(self, adapter: Any) -> AdapterBinding | None:
        return self._by_instance.get(adapter)

    def attached_channels(self) -> dict[str, str]:
        return {binding.channel: "ok" for binding in self._by_adapter_id.values()}

    def attached_adapter_ids(self) -> list[str]:
        return sorted(self._by_adapter_id)

    def attach(
        self,
        adapter: Any,
        *,
        adapter_id: str,
        channel: str,
        account_id: str | None = None,
        default_transport: str = "queued-push",
        transport_resolver: TransportResolver | None = None,
        capture_filter: CaptureFilter | None = None,
        delivery_override: DeliveryOverride | None = None,
    ) -> AdapterBinding:
        existing = self.binding_for(adapter)
        if existing is not None:
            if existing.adapter_id != adapter_id or existing.channel != channel:
                raise ValueError("adapter object is already attached with different identity")
            return existing
        if default_transport not in {"queued-push", "inline-response"}:
            raise ValueError("default_transport must be queued-push or inline-response")
        original_send = getattr(adapter, "send", None)
        if not callable(original_send):
            raise TypeError("adapter.send must be callable")
        original_edit = getattr(adapter, "edit_message", None)
        original_media = {
            method: candidate
            for method in MEDIA_METHODS
            if callable(candidate := getattr(adapter, method, None))
        }
        binding = AdapterBinding(
            adapter=adapter,
            adapter_id=adapter_id,
            channel=channel,
            account_id=account_id,
            default_transport=default_transport,
            original_send=original_send,
            original_edit=original_edit if callable(original_edit) else None,
            original_media=original_media,
            transport_resolver=transport_resolver,
            capture_filter=capture_filter,
            delivery_override=delivery_override,
        )
        self._by_instance[adapter] = binding
        self._by_adapter_id[adapter_id] = binding
        return binding

    async def deliver(
        self,
        message_id: str,
        attempt_id: str,
        expected_content_sha256: str,
    ) -> dict[str, Any]:
        row = self.outbox.get_delivery(message_id)
        if row is None:
            raise KeyError(message_id)
        if row["contentSha256"] != expected_content_sha256:
            raise ValueError("content hash conflict")
        if row["state"] == "delivered":
            return self._ack(row, attempt_id=attempt_id, accepted=True, deduped=True)
        if row["state"] == "delivering":
            # A native send from an earlier request is still in flight (for
            # example the gateway restarted while the Bridge was sending).
            # Wait for its durable outcome instead of starting a second send.
            return await self._wait_delivery_final(message_id, attempt_id)

        binding = self._by_adapter_id.get(row["adapterId"])
        if binding is None:
            raise RuntimeError(f"adapter is not attached: {row['adapterId']}")
        started = self.outbox.begin_delivery(
            message_id,
            attempt_id,
            expected_content_sha256,
        )
        if started["deduped"]:
            current = started["message"]
            return self._ack(current, attempt_id=attempt_id, accepted=True, deduped=True)

        try:
            with native_delivery_scope():
                result = await self._invoke_native(binding, row)
        except asyncio.CancelledError as exc:
            self.outbox.mark_unknown(message_id, attempt_id, str(exc) or "delivery cancelled")
            raise
        except Exception as exc:
            current = self.outbox.mark_unknown(message_id, attempt_id, str(exc))
            return self._ack(
                current,
                attempt_id=attempt_id,
                accepted=False,
                deduped=False,
                error=str(exc),
            )

        if bool(getattr(result, "success", False)):
            current = self.outbox.finish_delivery(
                message_id,
                attempt_id,
                getattr(result, "message_id", None),
            )
            return self._ack(current, attempt_id=attempt_id, accepted=True, deduped=False)

        error = str(getattr(result, "error", None) or "native send failed")
        current = self.outbox.mark_retry(message_id, attempt_id, error)
        return self._ack(
            current,
            attempt_id=attempt_id,
            accepted=False,
            deduped=False,
            error=error,
        )

    async def _wait_delivery_final(
        self,
        message_id: str,
        attempt_id: str,
        timeout_s: float = 110.0,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_s
        while True:
            current = self.outbox.get_delivery(message_id)
            if current is None:
                raise KeyError(message_id)
            if current["state"] != "delivering":
                return self._ack(
                    current,
                    attempt_id=attempt_id,
                    accepted=current["state"] == "delivered",
                    deduped=True,
                )
            if time.monotonic() >= deadline:
                return self._ack(
                    current,
                    attempt_id=attempt_id,
                    accepted=True,
                    deduped=True,
                )
            await asyncio.sleep(1.0)

    async def _invoke_native(
        self,
        binding: AdapterBinding,
        row: dict[str, Any],
    ) -> Any:
        native_row = dict(row)
        metadata = row.get("metadata")
        native_row["metadata"] = (
            {key: value for key, value in metadata.items() if key != "proactive"}
            if isinstance(metadata, Mapping)
            else {}
        )
        if binding.delivery_override is not None:
            result = binding.delivery_override(native_row)
            return await result if inspect.isawaitable(result) else result
        route = native_row.get("_deliveryRoute")
        if isinstance(route, Mapping) and route.get("kind") == "media":
            return await self._invoke_media(binding, native_row, route)
        return await binding.original_send(
            native_row["chatId"],
            native_row["content"],
            reply_to=native_row["replyTo"],
            metadata=native_row["metadata"],
        )

    @staticmethod
    async def _invoke_media(
        binding: AdapterBinding,
        row: dict[str, Any],
        route: Mapping[str, Any],
    ) -> Any:
        method_name = str(route.get("method") or "")
        method = binding.original_media.get(method_name)
        if method is None:
            raise RuntimeError(f"media method is not attached: {method_name}")
        if method_name in {"send_image", "send_animation"}:
            source = route.get("source")
            if not isinstance(source, str) or not source:
                raise RuntimeError("remote media source is not available")
            return await method(
                row["chatId"],
                source,
                caption=row["content"] if route.get("hasCaption") else None,
                reply_to=row["replyTo"],
                metadata=row["metadata"],
            )
        if method_name == "send_multiple_images":
            raw_images = route.get("images")
            if not isinstance(raw_images, list) or not raw_images:
                raise RuntimeError("multiple-image payload is not available")
            images: list[tuple[str, str]] = []
            for item in raw_images:
                if not isinstance(item, Mapping):
                    raise RuntimeError("multiple-image payload is invalid")
                source = item.get("source")
                caption = item.get("caption")
                if not isinstance(source, str) or not source:
                    raise RuntimeError("multiple-image source is not available")
                images.append((source, "" if caption is None else str(caption)))
            human_delay = route.get("humanDelay", 0.0)
            if isinstance(human_delay, bool) or not isinstance(human_delay, (int, float)):
                raise RuntimeError("multiple-image human delay is invalid")
            result = await method(
                row["chatId"],
                images,
                metadata=row["metadata"],
                human_delay=float(human_delay),
            )
            return _normalize_media_result(result)
        attachment_id = route.get("attachmentId")
        attachment = next(
            (
                item
                for item in row.get("_attachments", [])
                if item.get("attachmentId") == attachment_id
            ),
            None,
        )
        if attachment is None:
            raise RuntimeError("media attachment is not available")
        caption = row["content"] if route.get("hasCaption") else None
        kwargs: dict[str, Any] = {
            "caption": caption,
            "reply_to": row["replyTo"],
            "metadata": row["metadata"],
        }
        if method_name == "send_document" and route.get("fileName") is not None:
            kwargs["file_name"] = route["fileName"]
        return await method(row["chatId"], attachment["spoolPath"], **kwargs)

    async def prewarm(self, channel: str) -> dict[str, Any]:
        checked_at = datetime.now(timezone.utc)
        binding = next(
            (item for item in self._by_adapter_id.values() if item.channel == channel),
            None,
        )
        if binding is None:
            return {
                "channel": channel,
                "warmed": False,
                "checkedAt": checked_at.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "expiresAt": None,
                "detail": "channel adapter is not attached",
            }
        hook = getattr(binding.adapter, "prewarm_channel", None)
        if not callable(hook):
            # No warm-up procedure exists on this adapter: being attached is the
            # warm state. Treating this as unwarmed would deadlock queued-push
            # delivery (the reconciler holds every normal message indefinitely).
            expires_at = checked_at + timedelta(minutes=5)
            return {
                "channel": channel,
                "warmed": True,
                "checkedAt": checked_at.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "expiresAt": expires_at.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "detail": "no prewarm hook; adapter is attached and considered warm",
            }
        try:
            result = await hook()
        except Exception as exc:
            return {
                "channel": channel,
                "warmed": False,
                "checkedAt": checked_at.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "expiresAt": None,
                "detail": str(exc),
            }
        warmed = bool(result if isinstance(result, bool) else getattr(result, "warmed", False))
        expires_at = checked_at + timedelta(minutes=5) if warmed else None
        return {
            "channel": channel,
            "warmed": warmed,
            "checkedAt": checked_at.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "expiresAt": (
                expires_at.isoformat(timespec="milliseconds").replace("+00:00", "Z")
                if expires_at is not None
                else None
            ),
            "detail": None if warmed else "prewarm hook reported unavailable",
        }

    @staticmethod
    def _ack(
        row: dict[str, Any],
        *,
        attempt_id: str,
        accepted: bool,
        deduped: bool,
        error: str | None = None,
    ) -> dict[str, Any]:
        ack = {
            "messageId": row["messageId"],
            "attemptId": attempt_id,
            "accepted": accepted,
            "deduped": deduped,
            "state": row["state"],
            "providerMessageId": row["providerMessageId"],
            "finishedAt": row["deliveredAt"] or row["updatedAt"],
        }
        if error is not None:
            ack["error"] = error
        return ack


def _normalize_media_result(result: Any) -> Any:
    if result is not None:
        return result
    return MediaSendResult()
