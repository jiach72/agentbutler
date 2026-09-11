"""GatewayRunner 生命周期 mixin：关停阶段（fixture，模拟 Hermes v0.21.0 拆分）。"""


class GatewayShutdownMixin:
    async def stop(self):
        return None
