class TurnRunner:
    def progress_callback(self, event_type, tool_name=None, preview=None, args=None, **kwargs):
        return None


class GatewayRunner:
    """v0.21.0 起生命周期方法拆分至 run_startup / run_shutdown / run_adapters /
    run_turn 四个 mixin（见各文件），本类保留运行时入口。"""

    async def start(self):
        return True

    async def stop(self):
        return None


def main():
    return 0


if __name__ == "__main__":
    main()

# ---- END PLUGIN-COMPAT ----
