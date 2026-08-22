class BasePlatformAdapter:
    async def handle_message(self, event):
        return event

    async def _process_message_background(self, event, session_key):
        return event, session_key

    def split_message(self, text):
        chunks = [text]
        return chunks
