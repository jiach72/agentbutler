class APIServerAdapter:
    def __init__(self):
        self._host = "127.0.0.1"
        self._port = 8642

    async def _run_agent(self, user_message, conversation_history, **kwargs):
        return ({"final_response": user_message}, {})

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        raise RuntimeError("HTTP response path")

    async def get_chat_info(self, chat_id):
        return {
            "name": "API Server",
            "type": "api",
            "host": self._host,
            "port": self._port,
        }
