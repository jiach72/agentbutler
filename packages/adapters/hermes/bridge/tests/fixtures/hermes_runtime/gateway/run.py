class TurnRunner:
    def progress_callback(self, event_type, tool_name=None, preview=None, args=None, **kwargs):
        return None


class GatewayRunner:
    async def start(self):
        return True

    async def stop(self):
        return None

    async def _connect_adapter_with_timeout(self, adapter, platform, **kwargs):
        return await adapter.connect(**kwargs)

    async def _run_agent_inner(self, *args, **kwargs):
        return {"final_response": "ok"}


def main():
    return 0


if __name__ == "__main__":
    main()
