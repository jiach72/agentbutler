"""Request and turn-local correlation context for Hermes Bridge hooks."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field, replace
import threading
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


@dataclass
class RunLifecycleState:
    run_id: str
    failed: bool = False
    progress_sequence: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)


_CURRENT_CONTEXT: ContextVar[MessageContext] = ContextVar(
    "agent_butler_message_context",
    default=MessageContext(),
)
_NATIVE_DELIVERY: ContextVar[bool] = ContextVar(
    "agent_butler_native_delivery",
    default=False,
)
_RUN_LIFECYCLE: ContextVar[RunLifecycleState | None] = ContextVar(
    "agent_butler_run_lifecycle",
    default=None,
)


def current_message_context() -> MessageContext:
    return _CURRENT_CONTEXT.get()


def native_delivery_active() -> bool:
    return _NATIVE_DELIVERY.get()


def current_run_lifecycle() -> RunLifecycleState | None:
    return _RUN_LIFECYCLE.get()


def current_run_failed() -> bool:
    state = current_run_lifecycle()
    return bool(state and state.failed)


def mark_current_run_failed() -> None:
    state = current_run_lifecycle()
    if state is not None:
        with state.lock:
            state.failed = True


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


@contextmanager
def native_delivery_scope() -> Iterator[None]:
    token = _NATIVE_DELIVERY.set(True)
    try:
        yield
    finally:
        _NATIVE_DELIVERY.reset(token)


@contextmanager
def run_lifecycle_scope(run_id: str) -> Iterator[RunLifecycleState]:
    if not isinstance(run_id, str) or not run_id:
        raise ValueError("run_id must be a non-empty string")
    state = RunLifecycleState(run_id=run_id)
    token = _RUN_LIFECYCLE.set(state)
    try:
        yield state
    finally:
        _RUN_LIFECYCLE.reset(token)
