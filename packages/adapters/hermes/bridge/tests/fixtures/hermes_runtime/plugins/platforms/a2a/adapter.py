from typing import Any, Dict


class A2AAdapter:
    def _send_push_notification(self, task_id, context_id, reply, state):
        return None

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        return None

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": f"a2a:{chat_id}", "type": "dm"}
