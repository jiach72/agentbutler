"""Declarative, file-tail Hermes patch specifications and static probes."""

from __future__ import annotations

import ast
from dataclasses import dataclass, field
from typing import Callable, Iterable


@dataclass(frozen=True)
class PatchSpec:
    path: str
    patch_id: str
    class_name: str
    methods: tuple[str, ...]
    tail_suffix: str
    install_function: str
    install_arguments: str
    #: (file_path, mixin_class_name) 对：v0.21.0 起官方把网关生命周期拆进 mixin 文件，
    #: 目标类的方法可能定义在这些相关文件的同名 mixin 类里，方法查找需一并纳入。
    method_sources: tuple[tuple[str, str], ...] = field(default_factory=tuple)

    @property
    def begin_marker(self) -> str:
        return f"# >>> Agent Butler managed hook: {self.patch_id}:v1 >>>"

    @property
    def end_marker(self) -> str:
        return f"# <<< Agent Butler managed hook: {self.patch_id}:v1 <<<"

    @property
    def block(self) -> str:
        alias = f"_agent_butler_install_{self.patch_id.replace('-', '_')}"
        return "\n".join(
            (
                self.begin_marker,
                f"from gateway.butler_bridge import {self.install_function} as {alias}",
                "",
                f"{alias}({self.install_arguments})",
                f"del {alias}",
                self.end_marker,
            )
        )

    def validate_base(self, text: str, read_file: Callable[[str], str] | None = None) -> None:
        if not text.rstrip().endswith(self.tail_suffix.rstrip()):
            raise PatchDriftError(f"{self.path}: expected file-tail suffix is absent")
        try:
            tree = ast.parse(text, filename=self.path)
        except SyntaxError as exc:
            raise PatchDriftError(f"{self.path}: Python syntax is invalid: {exc}") from exc
        class_node = next(
            (
                node
                for node in tree.body
                if isinstance(node, ast.ClassDef) and node.name == self.class_name
            ),
            None,
        )
        if class_node is None:
            raise PatchDriftError(f"{self.path}: class {self.class_name} is absent")
        available = {
            node.name
            for node in class_node.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        if self.method_sources:
            if read_file is None:
                raise PatchDriftError(
                    f"{self.path}: spec declares method_sources but no file reader was provided"
                )
            for source_path, source_class in self.method_sources:
                try:
                    source_text = read_file(source_path)
                except OSError as exc:
                    raise PatchDriftError(
                        f"{source_path}: cannot read mixin source: {exc}"
                    ) from exc
                try:
                    source_tree = ast.parse(source_text, filename=source_path)
                except SyntaxError as exc:
                    raise PatchDriftError(
                        f"{source_path}: Python syntax is invalid: {exc}"
                    ) from exc
                source_node = next(
                    (
                        node
                        for node in source_tree.body
                        if isinstance(node, ast.ClassDef) and node.name == source_class
                    ),
                    None,
                )
                if source_node is None:
                    raise PatchDriftError(f"{source_path}: class {source_class} is absent")
                available |= {
                    node.name
                    for node in source_node.body
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                }
        missing = sorted(set(self.methods) - available)
        if missing:
            raise PatchDriftError(
                f"{self.path}: required methods are absent: {', '.join(missing)}"
            )


class PatchDriftError(RuntimeError):
    """The target does not match the pinned semantic and file-tail anchors."""


PATCH_SPECS: tuple[PatchSpec, ...] = (
    PatchSpec(
        path="gateway/platforms/base.py",
        patch_id="base-platform",
        class_name="BasePlatformAdapter",
        methods=("handle_message", "_process_message_background"),
        tail_suffix="        return chunks",
        install_function="install_base_platform_hooks",
        install_arguments="BasePlatformAdapter",
    ),
    PatchSpec(
        path="gateway/run.py",
        patch_id="gateway-runtime",
        class_name="GatewayRunner",
        methods=("start", "stop", "_connect_adapter_with_timeout", "_run_agent_inner"),
        # v0.21.0 把 run.py 的尾部换成了 plugin-compat 兼容层，且生命周期方法
        # 拆进 run_startup/run_shutdown/run_adapters/run_turn 四个 mixin 文件。
        tail_suffix="# ---- END PLUGIN-COMPAT ----",
        method_sources=(
            ("gateway/run_startup.py", "GatewayStartupMixin"),
            ("gateway/run_shutdown.py", "GatewayShutdownMixin"),
            ("gateway/run_adapters.py", "GatewayAdapterLifecycleMixin"),
            ("gateway/run_turn.py", "GatewayTurnMixin"),
        ),
        install_function="install_gateway_runtime_hooks",
        install_arguments="GatewayRunner",
    ),
    PatchSpec(
        path="gateway/platforms/api_server.py",
        patch_id="api-server",
        class_name="APIServerAdapter",
        methods=("_run_agent", "send"),
        tail_suffix=(
            '        return {"name": "API Server", "type": "api", '
            '"host": self._host, "port": self._port}'
        ),
        install_function="install_api_server_hooks",
        install_arguments="APIServerAdapter",
    ),
    PatchSpec(
        path="plugins/platforms/a2a/adapter.py",
        patch_id="a2a",
        class_name="A2AAdapter",
        methods=("send", "_send_push_notification"),
        tail_suffix='            }.get(outcome, (protocol.STATE_COMPLETED, "")))',
        install_function="install_a2a_hooks",
        install_arguments="A2AAdapter",
    ),
)


def analyze_patch(
    text: str,
    spec: PatchSpec,
    read_file: Callable[[str], str] | None = None,
) -> str:
    """Return ``missing`` or ``installed``; raise on partial/ambiguous drift."""

    has_begin = spec.begin_marker in text
    has_end = spec.end_marker in text
    if has_begin or has_end:
        if text.count(spec.begin_marker) != 1 or text.count(spec.end_marker) != 1:
            raise PatchDriftError(f"{spec.path}: managed markers are duplicated or partial")
        marker_index = text.index(spec.begin_marker)
        base = text[:marker_index].rstrip()
        expected = render_patch(base, spec)
        if text != expected:
            raise PatchDriftError(f"{spec.path}: managed hook block has drifted")
        spec.validate_base(base, read_file)
        _compile(expected, spec.path)
        return "installed"

    spec.validate_base(text, read_file)
    _compile(render_patch(text, spec), spec.path)
    return "missing"


def render_patch(text: str, spec: PatchSpec) -> str:
    return f"{text.rstrip()}\n\n{spec.block}\n"


def static_coverage_rows(statuses: dict[str, str]) -> list[dict[str, str]]:
    by_id = {spec.patch_id: statuses.get(spec.path, "missing") for spec in PATCH_SPECS}

    def status(*patch_ids: str) -> str:
        return "declared" if all(by_id.get(item) == "installed" for item in patch_ids) else "missing"

    return [
        {"capability": "adapterAttach", "status": status("gateway-runtime")},
        {"capability": "inbound", "status": status("base-platform")},
        {"capability": "runLifecycle", "status": status("base-platform", "gateway-runtime")},
        {"capability": "progress", "status": status("gateway-runtime")},
        {"capability": "queuedSend", "status": status("base-platform", "gateway-runtime")},
        {"capability": "apiJson", "status": status("api-server")},
        {"capability": "apiSse", "status": status("api-server")},
        {"capability": "a2aWaiter", "status": status("a2a")},
        {"capability": "a2aPush", "status": status("a2a")},
        {"capability": "edit", "status": status("base-platform")},
        {"capability": "media", "status": status("base-platform")},
    ]


def patch_paths(specs: Iterable[PatchSpec] = PATCH_SPECS) -> tuple[str, ...]:
    return tuple(spec.path for spec in specs)


def _compile(text: str, filename: str) -> None:
    try:
        compile(text, filename, "exec")
    except SyntaxError as exc:
        raise PatchDriftError(f"{filename}: generated patch does not compile: {exc}") from exc
