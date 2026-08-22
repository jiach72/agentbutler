"""Identifier helpers used by the Bridge protocol."""

from __future__ import annotations

import os
import time
import uuid


def uuid7(*, now_ms: int | None = None, random_bytes: bytes | None = None) -> str:
    """Return an RFC 9562 UUIDv7 string.

    ``now_ms`` and ``random_bytes`` are injectable so ordering and bit layout
    can be verified without flaky timing-dependent tests.
    """

    timestamp = int(time.time_ns() // 1_000_000 if now_ms is None else now_ms)
    if timestamp < 0 or timestamp >= 1 << 48:
        raise ValueError("now_ms must fit in 48 bits")

    entropy = os.urandom(10) if random_bytes is None else random_bytes
    if len(entropy) != 10:
        raise ValueError("random_bytes must contain exactly 10 bytes")

    random_value = int.from_bytes(entropy, "big")
    rand_a = (random_value >> 68) & 0xFFF
    rand_b = random_value & ((1 << 62) - 1)
    value = (
        (timestamp << 80)
        | (0x7 << 76)
        | (rand_a << 64)
        | (0b10 << 62)
        | rand_b
    )
    return str(uuid.UUID(int=value))
