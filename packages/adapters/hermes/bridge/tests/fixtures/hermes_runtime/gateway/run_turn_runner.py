"""GatewayRunner 单轮对话拆分模块（fixture，模拟 Hermes v0.21.x 起的新路径）。

兼容垫片到期后，``gateway.run`` 的懒加载表不再是 TurnRunner 的可靠来源；
官方拆分后的稳定导入路径是本模块。fixture 通过继承 run_turn mixin 复现
「TurnRunner = 进度回调 + 单轮执行」的真实组合结构。
"""

from gateway.run_turn import GatewayTurnMixin


class TurnRunner(GatewayTurnMixin):
    def progress_callback(self, event_type, tool_name=None, preview=None, args=None, **kwargs):
        return None
