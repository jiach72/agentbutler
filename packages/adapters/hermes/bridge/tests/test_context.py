import asyncio
import unittest

from agent_butler_bridge.context import current_message_context, message_context


class MessageContextTest(unittest.IsolatedAsyncioTestCase):
    async def test_nested_context_merges_and_restores(self) -> None:
        self.assertIsNone(current_message_context().run_id)

        with message_context(session_id="session-1", run_id="run-1"):
            self.assertEqual(current_message_context().session_id, "session-1")
            self.assertEqual(current_message_context().run_id, "run-1")
            with message_context(run_id="run-2", priority="urgent"):
                nested = current_message_context()
                self.assertEqual(nested.session_id, "session-1")
                self.assertEqual(nested.run_id, "run-2")
                self.assertEqual(nested.priority, "urgent")
            self.assertEqual(current_message_context().run_id, "run-1")

        self.assertIsNone(current_message_context().session_id)

    async def test_context_is_isolated_between_async_tasks(self) -> None:
        async def read(run_id: str) -> str | None:
            with message_context(run_id=run_id):
                await asyncio.sleep(0)
                return current_message_context().run_id

        first, second = await asyncio.gather(read("run-a"), read("run-b"))

        self.assertEqual(first, "run-a")
        self.assertEqual(second, "run-b")
        self.assertIsNone(current_message_context().run_id)


if __name__ == "__main__":
    unittest.main()
