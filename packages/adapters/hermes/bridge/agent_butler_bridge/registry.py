"""Registry of original Hermes adapter methods used for managed delivery."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable
from weakref import WeakKeyDictionary

from .outbox import Outbox


SendCallable = Callable[..., Awaitable[Any]]
EditCallable = Callable[..., Awaitable[Any]]


@dataclass
class AdapterBinding:
    adapter: Any
    adapter_id: str
    channel: str
    account_id: str | None
    default_transport: str
    original_send: SendCallable
    original_edit: EditCallable | None


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

    def attach(
        self,
        adapter: Any,
        *,
        adapter_id: str,
        channel: str,
        account_id: str | None = None,
        default_transport: str = "queued-push",
    ) -> AdapterBinding:
        existing = self.binding_for(adapter)
        if existing is not None:
            return existing
        if default_transport not in {"queued-push", "inline-response"}:
            raise ValueError("default_transport must be queued-push or inline-response")
        original_send = getattr(adapter, "send", None)
        if not callable(original_send):
            raise TypeError("adapter.send must be callable")
        original_edit = getattr(adapter, "edit_message", None)
        binding = AdapterBinding(
            adapter=adapter,
            adapter_id=adapter_id,
            channel=channel,
            account_id=account_id,
            default_transport=default_transport,
            original_send=original_send,
            original_edit=original_edit if callable(original_edit) else None,
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
        row = self.outbox.get(message_id)
        if row is None:
            raise KeyError(message_id)
        if row["contentSha256"] != expected_content_sha256:
            raise ValueError("content hash conflict")
        if row["state"] == "delivered":
            return self._ack(row, attempt_id=attempt_id, accepted=True, deduped=True)

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
            result = await binding.original_send(
                row["chatId"],
                row["content"],
                reply_to=row["replyTo"],
                metadata=row["metadata"],
            )
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
            return {
                "channel": channel,
                "warmed": False,
                "checkedAt": checked_at.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "expiresAt": None,
                "detail": "adapter does not expose a prewarm hook",
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
