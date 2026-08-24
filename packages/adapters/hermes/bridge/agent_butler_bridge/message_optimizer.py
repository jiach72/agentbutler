"""M5 入站消息规则式优化器（快速通道）。

把微信等聊天软件里的口语消息整理成更明确的指令，再交给 Hermes。
设计约束：
- 只做安全、确定性的整理：去客套语、指代消解、常见口语动词归一、
  疑问句转明确指令、快捷指令展开；
- 规则不匹配或结果可疑时原样透传，绝不阻塞、绝不乱改；
- 本模块是纯函数，任何异常由调用方兜底，不得影响消息热路径。
"""

from __future__ import annotations

import re
from typing import Any

MODE_PASS_THROUGH = "pass-through"
MODE_QUICK = "quick"
MODE_RULE = "rule"

TRACE_PASS_THROUGH = "optimize:pass-through"
TRACE_QUICK_COMMAND = "optimize:quick-command"
TRACE_STRIP_FILLER = "optimize:strip-filler"
TRACE_DROP_DEMONSTRATIVE = "optimize:drop-demonstrative"
TRACE_RESOLVE_ANAPHORA = "optimize:resolve-anaphora"
TRACE_NORMALIZE_PHRASE = "optimize:normalize-phrase"
TRACE_QUESTION_TO_TASK = "optimize:question-to-task"
TRACE_STATEMENT_TO_TASK = "optimize:statement-to-task"
TRACE_REORDER_VERB_OBJECT = "optimize:reorder-verb-object"
TRACE_FIX_FAILURE_CLAUSE = "optimize:fix-failure-clause"

QUICK_TEMPLATES: dict[str, str] = {
    "/日报": "生成今天的日报并发给我",
    "/巡检": "运行一次巡检并报告结果",
    "/暂停推送": "暂停消息推送",
    "/恢复推送": "恢复消息推送",
}

_QUICK_RE = re.compile(r"^(/日报|/巡检|/暂停推送|/恢复推送)(?:\s+(\d+)\s*[hH时])?$")

_FILLER_RE = re.compile(
    r"^(?:请你?帮我看看|请帮我看看|麻烦你帮我看看|帮我看看|请你?帮我|请帮我|麻烦你帮我|麻烦你|帮我一下|帮我个忙|帮我检查|帮我查|能不能帮我|可以帮我|能不能|帮我|麻烦)\s*"
)

# 指代消解：管家管理的这台机器统一叫“本机”，避免 Hermes 理解成别的电脑。
_ANAPHORA_REPLACEMENTS: tuple[tuple[str, str], ...] = (
    ("你现在的这台电脑", "本机"),
    ("你现在的这台机器", "本机"),
    ("你现在这台电脑", "本机"),
    ("我这台电脑", "本机"),
    ("我的这台电脑", "本机"),
    ("你这台电脑", "本机"),
    ("这台电脑", "本机"),
    ("这台机器", "本机"),
    ("这台设备", "本机"),
    ("这台主机", "本机"),
    ("这台服务器", "本机"),
    ("我的电脑", "本机"),
    ("我的机器", "本机"),
    ("我电脑", "本机"),
)

# 口语动词归一：长词在前，避免“检查一下”被“查一下”误拆成“检查看一下”。
_PHRASE_REPLACEMENTS: tuple[tuple[str, str], ...] = (
    ("弄好一点", "改进"),
    ("弄好点", "改进"),
    ("弄好", "改进"),
    ("弄一下", "处理"),
    ("搞一下", "处理"),
    ("整一下", "处理"),
    ("检查一下", "检查"),
    ("查看一下", "查看"),
    ("看一下", "查看"),
    ("查一下", "查看"),
    ("调一下", "调整"),
    ("试试看", "尝试"),
    ("试一下", "尝试"),
    ("看看", "查看"),
    ("查查", "查看"),
    ("弄成", "设置为"),
    ("发一下", "发送"),
    ("但是呢", "但是"),
    ("可是呢", "可是"),
    ("然后呢", "然后"),
)

_VERB_YIXIA_RE = re.compile(
    r"(检查|查看|确认|测试|重启|更新|清理|恢复|暂停|运行|打开|关闭|调整|处理|优化|改进|完善|修复|设置|修改|删除|安装|卸载)一下"
)
_GUARDED_GAICHENG_RE = re.compile(r"(?<!变|更|修)改成")
_DEVICE_DEMONSTRATIVE_RE = re.compile(
    r"(?:这个|那个|这台|那台)(?=(?:小米|华为|苹果|联想|戴尔|惠普|三星|索尼)?(?:的)?(?:外接)?(?:显示器|电脑|打印机|音箱|摄像头|麦克风|路由器|硬盘|键盘|鼠标|屏幕|电视))"
)
_DEMONSTRATIVE_RE = re.compile(
    r"(把|给|关于|用|读|看|打开|检查|优化|改进|处理|设置|调整|修改|修复|重启|关闭|启动|运行|安装|删除|清空|卸载|调试|排查)\s*(?:那个|这个|这些|那些|那个什么|那个啥|这个啥)\s*"
)

# 疑问句转明确指令（顺序敏感：带动作的疑问句先处理，避免重复加“检查”）。
_QUESTION_CHECK_RE = re.compile(
    r"^(?:检查|查看|确认|测试)(.{1,50}?)(正常了吗|正常么|正常吗|是不是正常|有没有问题|有问题吗|还能用吗|能用吗|够用吗)[？?]?$"
)
_QUESTION_PLAIN_RE = re.compile(
    r"^(.{1,40}?)(正常了吗|正常么|正常吗|是不是正常|有没有问题|有问题吗|还能用吗|能用吗|够用吗|是不是坏了)[？?]?$"
)
_QUESTION_AGAIN_RE = re.compile(r"^是不是又(.{1,30}?)(?:了|了呢)[？?]?$")
_QUESTION_TROUBLE_RE = re.compile(r"^是不是(?:又)?出(?:什么)?问题了[？?]?$")
_QUESTION_WHY_RE = re.compile(r"^为什么(.{2,50}?)(?:了|呢)?[？?]?$")
_QUESTION_HOW_RE = re.compile(r"^(.{1,20}?)怎么(?:又)?(不|没|老是)(.{1,30}?)(?:了|了呢)?[？?]?$")

# 陈述句转更直接的指令。
_STATEMENT_DEFAULT_RE = re.compile(r"^我想把(.+?)默认(?:设置)?为(.+?)$")
_STATEMENT_SET_RE = re.compile(r"^我想把(.+?)(?:设置成|设置为|设为|改成|改为)(.+?)$")
_STATEMENT_BA_RE = re.compile(r"^我想(?:要)?(把.+)$")
_STATEMENT_VERB_RE = re.compile(
    r"^我想(?:要)?(查看|检查|打开|运行|启动|设置|修改|删除|清理|安装|卸载|重启|关闭|更新|下载|发送|生成|恢复|暂停|排查|调试|看看|测试)(.+)$"
)

# 把字句倒装转直接动宾（“把配置调整”→“调整配置”）。
_BA_REORDER_RE = re.compile(
    r"^把(.+?)(调整|修改|设置|清理|删除|安装|卸载|重启|关闭|打开|处理|修复|检查|查看|测试|优化|改进|完善|运行|恢复|暂停)([，,].*)?$"
)

_FAILURE_CLAUSE_RE = re.compile(r"不要再像上次那样(失败|出错)|不要像上次那样(失败|出错)|别像上次那样(失败|出错)")
_WS_RE = re.compile(r"[ \t]+")
_TRAILING_PUNCT_RE = re.compile(r"[。！!，,]+$")


def optimize_inbound(content: str) -> dict[str, Any]:
    """返回 { mode, optimizedText, transformTrace, changes }，永不抛异常。"""
    original = str(content or "")
    text = original.strip()
    if not text:
        return _result(MODE_PASS_THROUGH, original, [TRACE_PASS_THROUGH], [])

    quick = _match_quick(text)
    if quick is not None:
        return _result(
            MODE_QUICK,
            quick,
            [TRACE_QUICK_COMMAND],
            ["命中快捷指令，展开为完整指令"],
        )

    changes: list[str] = []
    trace: list[str] = []
    candidate = text

    filler = _FILLER_RE.match(candidate)
    if filler is not None:
        candidate = candidate[filler.end() :].strip()
        changes.append("去掉开头的客套话")
        trace.append(TRACE_STRIP_FILLER)

    if not candidate:
        return _result(MODE_PASS_THROUGH, original, [TRACE_PASS_THROUGH], [])

    def note(change: str, tr: str) -> None:
        changes.append(change)
        trace.append(tr)

    # 1. 指代消解：这台电脑 / 我的电脑 → 本机。
    for source, target in _ANAPHORA_REPLACEMENTS:
        if source in candidate:
            candidate = candidate.replace(source, target, 1)
            note(f"把“{source}”改成“{target}”", TRACE_RESOLVE_ANAPHORA)

    # 2. 常见口语动词归一。
    for source, target in _PHRASE_REPLACEMENTS:
        if source in candidate:
            candidate = candidate.replace(source, target, 1)
            note(f"把“{source}”改成“{target}”", TRACE_NORMALIZE_PHRASE)

    def apply(pattern: re.Pattern[str], replacement: str, change: str, tr: str) -> None:
        nonlocal candidate
        candidate, count = pattern.subn(replacement, candidate, count=1)
        if count > 0:
            changes.append(change)
            trace.append(tr)

    def apply_verb_yixia(match: re.Match[str]) -> str:
        verb = match.group(1)
        note(f"把“{verb}一下”改成“{verb}”", TRACE_NORMALIZE_PHRASE)
        return verb

    candidate = _VERB_YIXIA_RE.sub(apply_verb_yixia, candidate)
    apply(_GUARDED_GAICHENG_RE, "改为", "把“改成”改成“改为”", TRACE_NORMALIZE_PHRASE)

    # 3. 指代词消解：设备名词前多余的“这个 / 那个 / 这台”。
    apply(_DEVICE_DEMONSTRATIVE_RE, "", "去掉指代词，明确对象", TRACE_DROP_DEMONSTRATIVE)
    apply(_DEMONSTRATIVE_RE, r"\1", "去掉指代词，明确对象", TRACE_DROP_DEMONSTRATIVE)

    # 4. 陈述句转直接指令。
    statement = _STATEMENT_DEFAULT_RE.match(candidate)
    if statement is not None:
        candidate = f"将默认{statement.group(1)}设置为{statement.group(2)}"
        note("把“我想把X默认为Y”改成“将默认X设置为Y”", TRACE_STATEMENT_TO_TASK)
    else:
        statement = _STATEMENT_SET_RE.match(candidate)
        if statement is not None:
            candidate = f"将{statement.group(1)}设置为{statement.group(2)}"
            note("把“我想把X设置为Y”改成“将X设置为Y”", TRACE_STATEMENT_TO_TASK)
        else:
            statement = _STATEMENT_BA_RE.match(candidate)
            if statement is not None:
                candidate = statement.group(1)
                note("把“我想把X”改成“把X”，指令更直接", TRACE_STATEMENT_TO_TASK)
            else:
                statement = _STATEMENT_VERB_RE.match(candidate)
                if statement is not None:
                    candidate = f"{statement.group(1)}{statement.group(2)}"
                    note("把“我想做X”改成“X”", TRACE_STATEMENT_TO_TASK)

    # 5. 疑问句转明确指令。
    question = _QUESTION_AGAIN_RE.match(candidate)
    if question is not None:
        candidate = f"检查是否又{question.group(1)}，并报告结果"
        note("把“是不是又……了”改成明确指令", TRACE_QUESTION_TO_TASK)
    else:
        question = _QUESTION_TROUBLE_RE.match(candidate)
        if question is not None:
            candidate = "检查是否出现问题，并报告结果"
            note("把“是不是出问题了”改成明确指令", TRACE_QUESTION_TO_TASK)
        else:
            question = _QUESTION_WHY_RE.match(candidate)
            if question is not None and not re.match(r"^(?:是|有|在)", question.group(1)):
                candidate = f"排查{question.group(1)}的原因，并报告结果"
                note("把“为什么……”改成明确指令", TRACE_QUESTION_TO_TASK)
            else:
                question = _QUESTION_HOW_RE.match(candidate)
                if question is not None:
                    candidate = (
                        f"排查{question.group(1)}{question.group(2)}{question.group(3)}的原因，并报告结果"
                    )
                    note("把“怎么不/没……”改成明确指令", TRACE_QUESTION_TO_TASK)
                else:
                    question = _QUESTION_CHECK_RE.match(candidate)
                    if question is not None:
                        candidate = f"检查{question.group(1)}是否正常，并报告结果"
                        note("把“……正常了吗？”改成明确指令", TRACE_QUESTION_TO_TASK)
                    else:
                        question = _QUESTION_PLAIN_RE.match(candidate)
                        if question is not None:
                            candidate = f"检查{question.group(1)}是否正常，并报告结果"
                            note("把“……正常了吗？”改成明确指令", TRACE_QUESTION_TO_TASK)

    # 6. 把字句倒装。
    ba = _BA_REORDER_RE.match(candidate)
    if ba is not None:
        verb = ba.group(2)
        candidate = f"{verb}{ba.group(1)}{ba.group(3) or ''}"
        note(f"把“把X{verb}”改成“{verb}X”，指令更直接", TRACE_REORDER_VERB_OBJECT)

    # 7. 失败句式改写。
    failure = _FAILURE_CLAUSE_RE.search(candidate)
    if failure is not None:
        matched = failure.group(0)
        candidate = _FAILURE_CLAUSE_RE.sub("避免上次的失败", candidate, count=1)
        note(f"把“{matched}”改成“避免上次的失败”", TRACE_FIX_FAILURE_CLAUSE)

    candidate = _WS_RE.sub(" ", candidate).strip()
    candidate = _TRAILING_PUNCT_RE.sub("", candidate).strip()

    if not candidate or candidate == text:
        return _result(MODE_PASS_THROUGH, original, [TRACE_PASS_THROUGH], [])
    if len(candidate) > len(original) * 3 + 200:
        return _result(MODE_PASS_THROUGH, original, [TRACE_PASS_THROUGH], [])

    return _result(MODE_RULE, candidate, trace, changes)


def _match_quick(text: str) -> str | None:
    match = _QUICK_RE.match(text)
    if match is None:
        return None
    command = match.group(1)
    if command == "/暂停推送":
        duration = match.group(2)
        if duration is not None:
            return f"暂停消息推送 {duration} 小时"
    return QUICK_TEMPLATES.get(command)


def _result(mode: str, optimized_text: str, trace: list[str], changes: list[str]) -> dict[str, Any]:
    return {
        "mode": mode,
        "optimizedText": optimized_text,
        "transformTrace": trace,
        "changes": changes,
    }