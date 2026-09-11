"""GatewayRunner 生命周期 mixin：单轮对话（fixture，模拟 Hermes v0.21.0 拆分）。"""


class GatewayTurnMixin:
    async def _run_agent_inner(self, *args, **kwargs):
        return {"final_response": "ok"}
