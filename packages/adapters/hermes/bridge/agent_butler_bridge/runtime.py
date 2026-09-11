"""Process lifecycle for the Hermes-side Agent Butler Bridge."""

from __future__ import annotations

import asyncio
import ipaddress
import os
import stat
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from aiohttp import web

from .channel_control import ChannelControl
from .llm_optimizer import LlmConfig
from .outbox import Outbox
from .registry import AdapterBinding, NativeRegistry
from .server import create_app
from .weixin_login import WeixinLoginManager
from .wrapper import attach_adapter


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8754
RETENTION_SWEEP_INTERVAL_SECONDS = 60 * 60
MAX_TOKEN_BYTES = 4096

# Hermes 取证日志（gateway-exit-diag / gateway-shutdown-diag）由 Hermes 侧
# 每次启动/关停追加且无轮转，长期常驻只增不减。写入方是 Hermes 文件，
# 直接改动会被 Hermes 更新覆盖；本函数由 Butler 管理的 bridge 包在
# retention 清扫里调用，随 bridge 安装/同步存在，天然抗更新覆盖。
# 这些写入方每次追加都按路径重新 open，replace 截断不会让 fd 写丢。
DIAG_LOG_CAP_BYTES = 4 * 1024 * 1024
DIAG_LOG_KEEP_BYTES = 1024 * 1024
DIAG_LOG_FILES = ("gateway-exit-diag.log", "gateway-shutdown-diag.log")
TRUE_VALUES = {"1", "true", "yes", "on"}
REQUIRED_RUNTIME_COVERAGE = (
    "runtime",
    "adapterAttach",
    "inbound",
    "runLifecycle",
    "progress",
    "queuedSend",
    "apiJson",
    "apiSse",
    "a2aWaiter",
    "a2aPush",
    "edit",
    "media",
)


@dataclass(frozen=True)
class RuntimeConfig:
    instance_id: str
    host: str
    port: int
    token_file: Path
    outbox_path: Path
    allow_non_loopback: bool = False
    inbound_optimize: bool = True
    llm: LlmConfig | None = None

    @classmethod
    def from_env(cls) -> "RuntimeConfig":
        home = Path(os.environ.get("HOME") or Path.home())
        private_root = home / ".hermes" / "agent-butler"
        return cls(
            instance_id=os.environ.get("HERMES_BUTLER_INSTANCE_ID", "hermes-main").strip()
            or "hermes-main",
            host=os.environ.get("HERMES_BUTLER_HOST", DEFAULT_HOST).strip() or DEFAULT_HOST,
            port=_read_port(os.environ.get("HERMES_BUTLER_PORT")),
            token_file=Path(
                os.environ.get(
                    "HERMES_BUTLER_TOKEN_FILE",
                    str(private_root / "bridge.token"),
                )
            ).expanduser(),
            outbox_path=Path(
                os.environ.get(
                    "HERMES_BUTLER_OUTBOX_PATH",
                    str(private_root / "outbox.sqlite"),
                )
            ).expanduser(),
            allow_non_loopback=os.environ.get(
                "HERMES_BUTLER_ALLOW_NON_LOOPBACK", ""
            ).strip().casefold()
            in TRUE_VALUES,
            inbound_optimize=os.environ.get(
                "HERMES_BUTLER_INBOUND_OPTIMIZE", "1"
            ).strip().casefold()
            in TRUE_VALUES,
            llm=LlmConfig.from_env(),
        )


class BridgeRuntime:
    """Own exactly one Bridge HTTP server, registry, and Outbox."""

    def __init__(
        self,
        config: RuntimeConfig,
        channel_control: ChannelControl | None = None,
        weixin_login: WeixinLoginManager | None = None,
    ):
        self.config = config
        self.channel_control: ChannelControl | None = channel_control
        self.weixin_login: WeixinLoginManager | None = weixin_login
        self.outbox: Outbox | None = None
        self.registry: NativeRegistry | None = None
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self._bound_port: int | None = None
        self._started_at: str | None = None
        self._coverage: dict[str, str] = {}
        self._lifecycle_lock = asyncio.Lock()
        self._inbound_optimization_tasks: dict[str, asyncio.Task[None]] = {}
        self._retention_task: asyncio.Task[None] | None = None

    @property
    def started(self) -> bool:
        return self._runner is not None and self._site is not None

    @property
    def bound_port(self) -> int:
        if self._bound_port is None:
            raise RuntimeError("Bridge runtime is not started")
        return self._bound_port

    @property
    def base_url(self) -> str:
        host = self.config.host
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        return f"http://{host}:{self.bound_port}"

    async def start(self) -> "BridgeRuntime":
        async with self._lifecycle_lock:
            if self.started:
                return self
            _validate_config(self.config)
            token = _read_private_token(self.config.token_file)
            _ensure_private_directory(self.config.outbox_path.parent)
            _prepare_private_database(self.config.outbox_path)

            if self.channel_control is None:
                self.channel_control = ChannelControl()
            channel_control = self.channel_control
            # 懒初始化：WeixinLoginManager 的默认构造会延迟导入 gateway.platforms.weixin
            # （真实 Hermes 运行时才有），非微信部署 / 测试环境没有该模块。
            # server.py 对 weixin_login=None 已有降级响应，微信扫码接口不可用不影响其他通道。
            weixin_login = self.weixin_login
            outbox: Outbox | None = None
            runner: web.AppRunner | None = None
            try:
                outbox = Outbox(self.config.outbox_path)
                outbox.prune_history()
                _chmod_outbox_files(self.config.outbox_path)
                registry = NativeRegistry(outbox, instance_id=self.config.instance_id)
                app = create_app(
                    outbox,
                    registry,
                    token=token,
                    instance_id=self.config.instance_id,
                    coverage_provider=self.coverage_snapshot,
                    started_at_provider=lambda: self._started_at,
                    channel_control=channel_control,
                    channel_status_provider=lambda: channel_control.status_map(registry),
                    weixin_login=weixin_login,
                )
                runner = web.AppRunner(app, access_log=None)
                await runner.setup()
                site = web.TCPSite(runner, host=self.config.host, port=self.config.port)
                await site.start()

                self.outbox = outbox
                self.registry = registry
                self._runner = runner
                self._site = site
                self._bound_port = _site_bound_port(site, self.config.port)
                self._started_at = _utc_now()
                self.record_coverage("retention", "ok")
                self._retention_task = asyncio.create_task(self._retention_loop(outbox))
                return self
            except BaseException:
                if runner is not None:
                    await runner.cleanup()
                if outbox is not None:
                    outbox.close()
                self._reset()
                raise

    async def stop(self) -> None:
        async with self._lifecycle_lock:
            runner = self._runner
            outbox = self.outbox
            retention_task = self._retention_task
            self._retention_task = None
            if retention_task is not None:
                retention_task.cancel()
                try:
                    await retention_task
                except asyncio.CancelledError:
                    pass
            for task in tuple(self._inbound_optimization_tasks.values()):
                task.cancel()
            self._inbound_optimization_tasks.clear()
            self._reset()
            try:
                if runner is not None:
                    await runner.cleanup()
            finally:
                if outbox is not None:
                    outbox.close()

    async def _retention_loop(self, outbox: Outbox) -> None:
        while True:
            await asyncio.sleep(RETENTION_SWEEP_INTERVAL_SECONDS)
            try:
                outbox.prune_history()
                self.record_coverage("retention", "ok")
            except Exception:
                # Retention must not take the Bridge down; health exposes the degraded
                # housekeeping state so operators can inspect the private SQLite file.
                self.record_coverage("retention", "degraded")
            try:
                hermes_home = Path(os.environ.get("HOME") or Path.home()) / ".hermes"
                cap_diag_logs(hermes_home)
            except Exception as exc:
                # 诊断日志封顶是纯收益动作：失败只留一行告警，不影响 retention 状态。
                print(f"[butler-bridge] diag log cap failed: {exc}", file=sys.stderr, flush=True)

    def attach_adapter(
        self,
        adapter: Any,
        *,
        adapter_id: str,
        channel: str,
        account_id: str | None = None,
        default_transport: str = "queued-push",
    ) -> AdapterBinding:
        registry = self.registry
        if registry is None:
            raise RuntimeError("Bridge runtime is not started")
        return attach_adapter(
            adapter,
            registry,
            adapter_id=adapter_id,
            channel=channel,
            account_id=account_id,
            default_transport=default_transport,
        )

    def coverage_snapshot(self) -> dict[str, str]:
        registry = self.registry
        attached = registry is not None and bool(registry.attached_channels())
        dynamic = dict(sorted(self._coverage.items()))
        coverage = {
            key: dynamic.get(key, "pending") for key in REQUIRED_RUNTIME_COVERAGE
        }
        coverage.update(
            {
                "runtime": "ok" if self.started else "starting",
                "adapterAttach": "ok" if attached else "pending",
                "queuedSend": _aggregate_coverage(dynamic, "queuedSend:"),
                "edit": _aggregate_coverage(dynamic, "edit:"),
                "media": _aggregate_coverage(dynamic, "mediaDirect:"),
            }
        )
        return {**dynamic, **coverage}

    def record_coverage(self, key: str, status: str) -> None:
        if not isinstance(key, str) or not key:
            raise ValueError("coverage key must be a non-empty string")
        if status not in {"ok", "degraded", "unavailable", "pending"}:
            raise ValueError("invalid coverage status")
        self._coverage[key] = status

    def schedule_inbound_optimization(self, inbound_id: str, content: str) -> None:
        """后台生成入站优化决策，不让 LLM 拖住消息处理。"""
        if inbound_id in self._inbound_optimization_tasks:
            return
        from .hermes_hooks import _ensure_inbound_decision

        task = asyncio.create_task(_ensure_inbound_decision(self, inbound_id, content))
        self._inbound_optimization_tasks[inbound_id] = task

        def finished(_task: asyncio.Task[None]) -> None:
            if self._inbound_optimization_tasks.get(inbound_id) is _task:
                self._inbound_optimization_tasks.pop(inbound_id, None)

        task.add_done_callback(finished)

    async def wait_inbound_optimization(self, inbound_id: str) -> None:
        """等待已启动的入站优化完成；已不存在则立即返回。"""
        task = self._inbound_optimization_tasks.get(inbound_id)
        if task is None:
            return
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            return

    def _reset(self) -> None:
        self.outbox = None
        self.registry = None
        self._runner = None
        self._site = None
        self._bound_port = None
        self._started_at = None
        self._coverage.clear()
        self._inbound_optimization_tasks.clear()
        self._retention_task = None


_process_runtime: BridgeRuntime | None = None


def get_process_runtime() -> BridgeRuntime | None:
    return _process_runtime


def cap_diag_logs(
    hermes_home: Path,
    *,
    cap_bytes: int = DIAG_LOG_CAP_BYTES,
    keep_bytes: int = DIAG_LOG_KEEP_BYTES,
    files: tuple[str, ...] = DIAG_LOG_FILES,
) -> list[str]:
    """把 Hermes 取证日志封顶在 ``cap_bytes`` 内（保留尾部 ``keep_bytes``）。

    返回实际被截断的文件名列表。日志不存在/未超限/截断失败都静默跳过——
    这是从属收益动作，绝不影响 Bridge 本身。先写临时文件再原子替换，
    与写入方"每次追加按路径重新 open"的访问方式兼容。
    """
    if keep_bytes >= cap_bytes:
        raise ValueError("keep_bytes must be smaller than cap_bytes")
    capped: list[str] = []
    logs_dir = hermes_home / "logs"
    for name in files:
        path = logs_dir / name
        try:
            size = path.stat().st_size
        except OSError:
            continue
        if size <= cap_bytes:
            continue
        tmp = path.with_name(path.name + ".cap-tmp")
        try:
            with open(path, "rb") as src, open(tmp, "wb") as dst:
                src.seek(size - keep_bytes)
                dst.write(src.read())
                dst.flush()
                os.fsync(dst.fileno())
            os.replace(tmp, path)
            capped.append(name)
        except OSError:
            try:
                tmp.unlink()
            except OSError:
                pass
    return capped


async def start_process_runtime(config: RuntimeConfig | None = None) -> BridgeRuntime:
    global _process_runtime
    requested = config or RuntimeConfig.from_env()
    if _process_runtime is None:
        _process_runtime = BridgeRuntime(requested)
    elif _process_runtime.config != requested:
        raise RuntimeError("Bridge process runtime is already configured differently")
    try:
        return await _process_runtime.start()
    except BaseException:
        if not _process_runtime.started:
            _process_runtime = None
        raise


async def stop_process_runtime() -> None:
    global _process_runtime
    runtime = _process_runtime
    _process_runtime = None
    if runtime is not None:
        await runtime.stop()


def _read_port(value: str | None) -> int:
    if value is None or not value.strip():
        return DEFAULT_PORT
    try:
        port = int(value)
    except ValueError as exc:
        raise ValueError("HERMES_BUTLER_PORT must be an integer") from exc
    if not 0 <= port <= 65535:
        raise ValueError("HERMES_BUTLER_PORT must be between 0 and 65535")
    return port


def _validate_config(config: RuntimeConfig) -> None:
    if not config.instance_id.strip():
        raise ValueError("instance_id must be a non-empty string")
    if not 0 <= config.port <= 65535:
        raise ValueError("Bridge port must be between 0 and 65535")
    if config.allow_non_loopback:
        return
    if config.host.casefold() == "localhost":
        return
    try:
        address = ipaddress.ip_address(config.host)
    except ValueError as exc:
        raise ValueError("Bridge host must be a numeric loopback address or localhost") from exc
    if not address.is_loopback:
        raise ValueError("Bridge host must remain on loopback")


def _read_private_token(path: Path) -> str:
    if path.is_symlink():
        raise PermissionError("Bridge token file must not be a symlink")
    try:
        file_stat = path.stat()
    except FileNotFoundError as exc:
        raise FileNotFoundError(f"Bridge token file not found: {path}") from exc
    if not stat.S_ISREG(file_stat.st_mode):
        raise PermissionError("Bridge token path must be a regular file")
    if stat.S_IMODE(file_stat.st_mode) & 0o077:
        raise PermissionError("Bridge token file must use mode 0600")
    if hasattr(os, "geteuid") and file_stat.st_uid != os.geteuid():
        raise PermissionError("Bridge token file must be owned by the gateway user")
    if file_stat.st_size > MAX_TOKEN_BYTES:
        raise ValueError("Bridge token file is too large")
    token = path.read_text(encoding="utf-8").strip()
    if not token:
        raise ValueError("Bridge token file must not be empty")
    return token


def _ensure_private_directory(path: Path) -> None:
    if path.exists() and path.is_symlink():
        raise PermissionError("Bridge data directory must not be a symlink")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)


def _prepare_private_database(path: Path) -> None:
    if path.exists():
        if path.is_symlink() or not path.is_file():
            raise PermissionError("Bridge Outbox path must be a regular file")
        path.chmod(0o600)
        return
    descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)


def _chmod_outbox_files(path: Path) -> None:
    for candidate in (path, Path(str(path) + "-wal"), Path(str(path) + "-shm")):
        if candidate.exists() and candidate.is_file() and not candidate.is_symlink():
            candidate.chmod(0o600)


def _site_bound_port(site: web.TCPSite, configured_port: int) -> int:
    server = getattr(site, "_server", None)
    sockets = getattr(server, "sockets", None)
    if sockets:
        return int(sockets[0].getsockname()[1])
    if configured_port > 0:
        return configured_port
    raise RuntimeError("Bridge server started without a discoverable bound port")


def _utc_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _aggregate_coverage(coverage: dict[str, str], prefix: str) -> str:
    statuses = [status for key, status in coverage.items() if key.startswith(prefix)]
    if not statuses:
        return "pending"
    if "unavailable" in statuses:
        return "unavailable"
    if "degraded" in statuses:
        return "degraded"
    if "pending" in statuses:
        return "pending"
    return "ok"
