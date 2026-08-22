"""Hermes-side Agent Butler message Bridge."""

from .ids import uuid7
from .hermes_hooks import (
    attach_runtime_adapter,
    install_a2a_hooks,
    install_api_server_hooks,
    install_base_platform_hooks,
    install_gateway_runtime_hooks,
)
from .outbox import Outbox
from .runtime import (
    BridgeRuntime,
    RuntimeConfig,
    get_process_runtime,
    start_process_runtime,
    stop_process_runtime,
)

__all__ = [
    "BridgeRuntime",
    "Outbox",
    "RuntimeConfig",
    "attach_runtime_adapter",
    "get_process_runtime",
    "install_a2a_hooks",
    "install_api_server_hooks",
    "install_base_platform_hooks",
    "install_gateway_runtime_hooks",
    "start_process_runtime",
    "stop_process_runtime",
    "uuid7",
]
