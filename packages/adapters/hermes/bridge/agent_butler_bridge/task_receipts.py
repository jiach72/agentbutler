"""Short, varied acknowledgements for managed Weixin task receipts."""

from __future__ import annotations

import secrets
from collections.abc import Callable


# Sixty-four openings and thirty-two closings form 2,048 curated, grammatically complete
# receipts. Every combination keeps the same promise: work has started and a
# later report will follow.
_TASK_RECEIPT_LEADS: tuple[str, ...] = (
    "任务已启动",
    "我先把这件事理出头绪",
    "思路已经上路",
    "工具已经就位",
    "线索已接住",
    "现在开始处理",
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
    "这件事我接手了",
    "我先去把门道摸清",
    "先把问题拆开来看",
    "正在把线索逐一核对",
    "我先把重点拎出来",
    "先从最关键的一步开始",
    "已经进入处理节奏",
    "先把答案从噪声里找出来",
    "正在翻开第一页",
    "先把脉络捋顺",
    "我先去问一问事实",
    "先把复杂处慢慢拆开",
    "正在把可能性一一排查",
    "我先给问题搭个骨架",
    "先让细节自己说话",
    "正在为你追踪进展",
    "先把该查的地方查清",
    "我先把问题放到显微镜下",
    "正在从头理顺",
    "先把关键信息收齐",
    "我先沿着线索往下走",
    "正在把分散消息归拢",
    "先把最难的部分顶住",
    "我先去把结论找回来",
    "正在让事情变得清楚",
    "先把每个环节看一遍",
    "我先把答案打磨一下",
    "正在往可靠的方向推进",
    "先把不确定的地方钉住",
    "我先替你把这件事跑一遍",
    "正在查到关键处",
    "先把问题的底摸清",
    "我先把来龙去脉理顺",
    "正在把答案往前推",
    "先把线头一根根收好",
    "我先去做一轮核验",
    "正在把事情办稳",
    "先把该做的先做起来",
    "我先把重点安排上",
    "正在跟进这件事",
    "先把路走出来",
    "我先把细节照看好",
    "正在找最合适的解法",
    "先让结论有据可依",
    "我先把这一程跑完",
    "正在往答案靠近",
    "先把下一步想明白",
    "我先开始忙这件事",
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
    "稍后把重点讲清。",
    "稍后把来龙去脉交代清楚。",
    "稍后把答案带回来。",
    "稍后把结果说透。",
    "稍后把进度告诉你。",
    "稍后给你一份清楚的汇报。",
    "稍后把结论和依据一起带来。",
    "稍后把关键信息整理好。",
    "稍后用结果和你说话。",
    "稍后给你一个踏实的答复。",
    "稍后把这件事的脉络讲明白。",
    "稍后带着新进展回来。",
    "稍后把处理结果送达。",
    "稍后把问题的答案讲清。",
    "稍后把收获一并带回。",
    "稍后给你交代。",
    "稍后把可用结论送来。",
    "稍后把下一步也说明白。",
    "稍后把事情的结果报上来。",
    "稍后带来值得一看的答案。",
    "稍后带回可靠消息。",
    "稍后把结果妥帖汇报。",
    "稍后带着答案回来。",
    "稍后和你同步结果。",
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
