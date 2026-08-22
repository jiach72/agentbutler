"""Request and turn-local correlation context for Hermes Bridge hooks."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, replace
from typing import Iterator


@dataclass(frozen=True)
class MessageContext:
    instance_id: str | None = None
    adapter_id: str | None = None
    channel: str | None = None
    account_id: str | None = None
    chat_id: str | None = None
    thread_id: str | None = None
    session_id: str | None = None
    run_id: str | None = None
    inbound_message_id: str | None = None
    message_kind: str | None = None
    transport: str | None = None
    priority: str | None = None


_CURRENT_CONTEXT: ContextVar[MessageContext] = ContextVar(
    "agent_butler_message_context",
    default=MessageContext(),
)


def current_message_context() -> MessageContext:
    return _CURRENT_CONTEXT.get()


@contextmanager
def message_context(**updates: str | None) -> Iterator[MessageContext]:
    unknown = set(updates) - set(MessageContext.__dataclass_fields__)
    if unknown:
        raise ValueError(f"unknown message context fields: {', '.join(sorted(unknown))}")
    for key, value in updates.items():
        if value is not None and (not isinstance(value, str) or not value):
            raise ValueError(f"{key} must be a non-empty string or None")
    merged = replace(current_message_context(), **updates)
    token = _CURRENT_CONTEXT.set(merged)
    try:
        yield merged
    finally:
        _CURRENT_CONTEXT.reset(token)
