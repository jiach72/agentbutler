"""GatewayRunner 生命周期 mixin：适配器连接（fixture，模拟 Hermes v0.21.0 拆分）。"""


class GatewayAdapterLifecycleMixin:
    async def _connect_adapter_with_timeout(self, adapter, platform, **kwargs):
        return await adapter.connect(**kwargs)
