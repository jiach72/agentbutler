"""Short, varied acknowledgements for managed Weixin task receipts."""

from __future__ import annotations

import secrets
from collections.abc import Callable


# Sixteen openings and eight closings form 128 curated, grammatically complete
# receipts. Every combination keeps the same promise: work has started and a
# later report will follow.
_TASK_RECEIPT_LEADS: tuple[str, ...] = (
    "任务已启动",
    "我先把这件事理出头绪",
    "思路已经上路",
    "工具已经就位",
    "线索已接住",
    "先做事",
    "思考引擎已点火",
    "正在把问题从问号变成句号",
    "先让证据排好队",
    "开始查办",
    "先让事实说清楚",
    "正在为结论铺路",
    "先把散点连成线",
    "答案正在路上",
    "先把难点摊平",
    "正在向结论靠拢",
)

_TASK_RECEIPT_TAILS: tuple[str, ...] = (
    "稍后汇报。",
    "稍后带回结论。",
    "稍后给你一个明白答案。",
    "稍后把结果整理好送来。",
    "稍后带回进展。",
    "稍后回来说明白。",
    "稍后给你回音。",
    "稍后见分晓。",
)

TASK_RECEIPT_MESSAGES: tuple[str, ...] = tuple(
    f"收到，{lead}，{tail}"
    for lead in _TASK_RECEIPT_LEADS
    for tail in _TASK_RECEIPT_TAILS
)


class TaskReceiptSelector:
    """Choose a task receipt without repeating the immediately prior one."""

    def __init__(self, random_index: Callable[[int], int] = secrets.randbelow) -> None:
        self._random_index = random_index
        self._last_index: int | None = None

    def choose(self) -> str:
        message_count = len(TASK_RECEIPT_MESSAGES)
        if self._last_index is None:
            index = self._random_index(message_count)
        else:
            candidate = self._random_index(message_count - 1)
            index = candidate if candidate < self._last_index else candidate + 1
        self._last_index = index
        return TASK_RECEIPT_MESSAGES[index]


_task_receipt_selector = TaskReceiptSelector()


def select_task_receipt() -> str:
    """Return a varied acknowledgement for a newly started task."""

    return _task_receipt_selector.choose()
