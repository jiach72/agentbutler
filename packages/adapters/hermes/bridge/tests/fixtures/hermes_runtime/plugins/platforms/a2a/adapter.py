from typing import Any, Dict


class A2AAdapter:
    def _send_push_notification(self, task_id, context_id, reply, state):
        outcome = state if state in ("completed", "failed") else "completed"
        return self._encode_task_state(outcome)

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        return None

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": f"a2a:{chat_id}", "type": "dm"}

    def _encode_task_state(self, outcome, protocol):
        return self._normalized({
                "completed": (protocol.STATE_COMPLETED, ""),
                "failed": (protocol.STATE_FAILED, "A2A push failed"),
            }.get(outcome, (protocol.STATE_COMPLETED, "")))
