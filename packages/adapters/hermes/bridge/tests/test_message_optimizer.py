"""M5 入站消息规则式优化器单元测试。"""

from __future__ import annotations

import unittest

from agent_butler_bridge.message_optimizer import (
    MODE_PASS_THROUGH,
    MODE_QUICK,
    MODE_RULE,
    optimize_inbound,
)


class MessageOptimizerTest(unittest.TestCase):
    def test_empty_and_whitespace_pass_through(self) -> None:
        for value in ("", "   ", "\n\t"):
            result = optimize_inbound(value)
            self.assertEqual(result["mode"], MODE_PASS_THROUGH)
            self.assertEqual(result["optimizedText"], value)
            self.assertEqual(result["transformTrace"], ["optimize:pass-through"])

    def test_plain_message_passes_through_unchanged(self) -> None:
        result = optimize_inbound("今天天气怎么样")
        self.assertEqual(result["mode"], MODE_PASS_THROUGH)
        self.assertEqual(result["optimizedText"], "今天天气怎么样")
        self.assertEqual(result["changes"], [])

    def test_quick_command_expands_template(self) -> None:
        result = optimize_inbound("/日报")
        self.assertEqual(result["mode"], MODE_QUICK)
        self.assertEqual(result["optimizedText"], "生成今天的日报并发给我")
        self.assertEqual(result["transformTrace"], ["optimize:quick-command"])

    def test_quick_command_with_duration(self) -> None:
        result = optimize_inbound("/暂停推送 2h")
        self.assertEqual(result["mode"], MODE_QUICK)
        self.assertEqual(result["optimizedText"], "暂停消息推送 2 小时")

    def test_prd_example_rewrites_colloquial_request(self) -> None:
        result = optimize_inbound("帮我把那个论文技能弄好点，别像上次那样失败")
        self.assertEqual(result["mode"], MODE_RULE)
        self.assertEqual(result["optimizedText"], "改进论文技能，避免上次的失败")
        self.assertIn("去掉开头的客套话", result["changes"])
        self.assertIn("去掉指代词，明确对象", result["changes"])
        self.assertIn("把“弄好点”改成“改进”", result["changes"])
        self.assertIn("optimize:strip-filler", result["transformTrace"])
        self.assertIn("optimize:drop-demonstrative", result["transformTrace"])
        self.assertIn("optimize:normalize-phrase", result["transformTrace"])
        self.assertIn("optimize:fix-failure-clause", result["transformTrace"])

    def test_strips_leading_filler_only(self) -> None:
        result = optimize_inbound("请帮我写一份周报")
        self.assertEqual(result["mode"], MODE_RULE)
        self.assertEqual(result["optimizedText"], "写一份周报")
        self.assertEqual(result["changes"], ["去掉开头的客套话"])

    def test_demonstrative_drop_keeps_object(self) -> None:
        result = optimize_inbound("把那个文件发给我")
        self.assertEqual(result["optimizedText"], "把文件发给我")
        self.assertIn("去掉指代词，明确对象", result["changes"])

    def test_optimization_is_idempotent(self) -> None:
        first = optimize_inbound("帮我把那个论文技能弄好点，别像上次那样失败")
        second = optimize_inbound(first["optimizedText"])
        self.assertEqual(second["optimizedText"], first["optimizedText"])

    def test_weird_input_never_raises(self) -> None:
        for value in ("🙂", "a" * 10000, "把", "帮我", "别像上次那样失败"):
            result = optimize_inbound(value)
            self.assertIn(result["mode"], {MODE_PASS_THROUGH, MODE_QUICK, MODE_RULE})
            self.assertIsInstance(result["optimizedText"], str)
            self.assertIsInstance(result["transformTrace"], list)
            self.assertIsInstance(result["changes"], list)


    def test_check_question_becomes_clear_instruction(self) -> None:
        result = optimize_inbound("检查一下现在显示器的配置正常了吗？")
        self.assertEqual(result["mode"], MODE_RULE)
        self.assertEqual(result["optimizedText"], "检查现在显示器的配置是否正常，并报告结果")
        self.assertNotIn("检查看一下", result["optimizedText"])
        self.assertIn("把“……正常了吗？”改成明确指令", result["changes"])

    def test_plain_question_becomes_check_instruction(self) -> None:
        result = optimize_inbound("显示器正常了吗？")
        self.assertEqual(result["optimizedText"], "检查显示器是否正常，并报告结果")

    def test_again_question_becomes_check_instruction(self) -> None:
        result = optimize_inbound("是不是又限流了？")
        self.assertEqual(result["optimizedText"], "检查是否又限流，并报告结果")

    def test_why_question_becomes_troubleshoot_instruction(self) -> None:
        result = optimize_inbound("为什么收不到消息了？")
        self.assertEqual(result["optimizedText"], "排查收不到消息的原因，并报告结果")

    def test_how_question_becomes_troubleshoot_instruction(self) -> None:
        result = optimize_inbound("微信怎么又不回复了？")
        self.assertEqual(result["optimizedText"], "排查微信不回复的原因，并报告结果")

    def test_long_anaphora_message_gets_structured_opening(self) -> None:
        message = (
            "我想把显示器默认为小米的这个外接显示器，因为笔记本的显示器已经坏了，"
            "无法显示，但是呢我只有打开远程控制软件的时候，显示器才会同步亮，"
            "如果远程控制软件关了以后显示器也会同步灭掉。我不知道是什么原因，"
            "就是你现在的这台电脑。"
        )
        result = optimize_inbound(message)
        self.assertEqual(result["mode"], MODE_RULE)
        self.assertTrue(
            result["optimizedText"].startswith("将默认显示器设置为小米的外接显示器")
        )
        self.assertTrue(result["optimizedText"].endswith("就是本机"))
        self.assertIn("把“你现在的这台电脑”改成“本机”", result["changes"])
        self.assertIn("去掉指代词，明确对象", result["changes"])

    def test_statement_set_becomes_direct(self) -> None:
        result = optimize_inbound("我想把显示器改成小米的")
        self.assertEqual(result["optimizedText"], "将显示器设置为小米的")

    def test_filler_with_look_becomes_check(self) -> None:
        result = optimize_inbound("帮我看看现在显示器配置正常吗")
        self.assertEqual(result["optimizedText"], "检查现在显示器配置是否正常，并报告结果")

    def test_new_rewrites_are_idempotent(self) -> None:
        samples = (
            "检查一下现在显示器的配置正常了吗？",
            "是不是又限流了？",
            "为什么收不到消息了？",
            "我想把显示器默认为小米的这个外接显示器",
            "微信怎么又不回复了？",
        )
        for sample in samples:
            first = optimize_inbound(sample)
            second = optimize_inbound(first["optimizedText"])
            self.assertEqual(second["optimizedText"], first["optimizedText"])

    def test_conversational_greetings_pass_through(self) -> None:
        for value in ("hi", "你好", "在线吗？", "在吗", "好吧"):
            result = optimize_inbound(value)
            self.assertEqual(result["mode"], MODE_PASS_THROUGH)
            self.assertEqual(result["optimizedText"], value)


if __name__ == "__main__":
    unittest.main()