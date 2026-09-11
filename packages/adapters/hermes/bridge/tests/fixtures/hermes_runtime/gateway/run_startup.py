"""GatewayRunner 生命周期 mixin：启动阶段（fixture，模拟 Hermes v0.21.0 拆分）。"""


class GatewayStartupMixin:
    async def start(self):
        return True
