"""消息链路模式：策略快照 relayMode 的唯一读取口。"""

from __future__ import annotations

RELAY_TAKEOVER = "takeover"
RELAY_PASSTHROUGH = "passthrough"
_RELAY_MODES = {RELAY_TAKEOVER, RELAY_PASSTHROUGH}


def relay_mode(outbox) -> str:
    """读取当前策略快照的 relayMode；缺失/非法一律回退 takeover。"""
    policy = outbox.get_policy_snapshot()
    if policy is None:
        return RELAY_TAKEOVER
    value = policy["payload"].get("relayMode", RELAY_TAKEOVER)
    return value if value in _RELAY_MODES else RELAY_TAKEOVER
