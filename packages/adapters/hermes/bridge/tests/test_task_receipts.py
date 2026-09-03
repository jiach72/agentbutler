from __future__ import annotations

import unittest

from agent_butler_bridge.task_receipts import TASK_RECEIPT_MESSAGES, TaskReceiptSelector


class TaskReceiptSelectorTests(unittest.TestCase):
    def test_pool_contains_128_unique_messages(self) -> None:
        self.assertEqual(len(TASK_RECEIPT_MESSAGES), 128)
        self.assertEqual(len(set(TASK_RECEIPT_MESSAGES)), 128)
        self.assertTrue(all(message.startswith("收到，") for message in TASK_RECEIPT_MESSAGES))
        self.assertTrue(all("稍后" in message for message in TASK_RECEIPT_MESSAGES))

    def test_selector_skips_the_immediately_previous_message(self) -> None:
        bounds: list[int] = []

        def lowest_index(upper_bound: int) -> int:
            bounds.append(upper_bound)
            return 0

        selector = TaskReceiptSelector(lowest_index)
        first = selector.choose()
        second = selector.choose()
        third = selector.choose()

        self.assertEqual(first, TASK_RECEIPT_MESSAGES[0])
        self.assertEqual(second, TASK_RECEIPT_MESSAGES[1])
        self.assertEqual(third, TASK_RECEIPT_MESSAGES[0])
        self.assertEqual(bounds, [128, 127, 127])
        self.assertNotEqual(first, second)
        self.assertNotEqual(second, third)


if __name__ == "__main__":
    unittest.main()
