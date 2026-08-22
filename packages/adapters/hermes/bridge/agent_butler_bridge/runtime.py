"""Process lifecycle for the Hermes-side Agent Butler Bridge."""

from __future__ import annotations

import asyncio
import ipaddress
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from aiohttp import web

from .outbox import Outbox
from .registry import AdapterBinding, NativeRegistry
from .server import create_app
from .wrapper import attach_adapter


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8754
MAX_TOKEN_BYTES = 4096
TRUE_VALUES = {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class RuntimeConfig:
    instance_id: str
    host: str
    port: int
    token_file: Path
    outbox_path: Path
    allow_non_loopback: bool = False

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
        )


class BridgeRuntime:
    """Own exactly one Bridge HTTP server, registry, and Outbox."""

    def __init__(self, config: RuntimeConfig):
        self.config = config
        self.outbox: Outbox | None = None
        self.registry: NativeRegistry | None = None
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self._bound_port: int | None = None
        self._started_at: str | None = None
        self._coverage: dict[str, str] = {}
        self._lifecycle_lock = asyncio.Lock()

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

            outbox: Outbox | None = None
            runner: web.AppRunner | None = None
            try:
                outbox = Outbox(self.config.outbox_path)
                _chmod_outbox_files(self.config.outbox_path)
                registry = NativeRegistry(outbox, instance_id=self.config.instance_id)
                app = create_app(
                    outbox,
                    registry,
                    token=token,
                    instance_id=self.config.instance_id,
                    coverage_provider=self.coverage_snapshot,
                    started_at_provider=lambda: self._started_at,
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
            self._reset()
            try:
                if runner is not None:
                    await runner.cleanup()
            finally:
                if outbox is not None:
                    outbox.close()

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
        return {
            "runtime": "ok" if self.started else "starting",
            "adapterAttach": "ok" if attached else "pending",
            **dict(sorted(self._coverage.items())),
        }

    def record_coverage(self, key: str, status: str) -> None:
        if not isinstance(key, str) or not key:
            raise ValueError("coverage key must be a non-empty string")
        if status not in {"ok", "degraded", "unavailable", "pending"}:
            raise ValueError("invalid coverage status")
        self._coverage[key] = status

    def _reset(self) -> None:
        self.outbox = None
        self.registry = None
        self._runner = None
        self._site = None
        self._bound_port = None
        self._started_at = None
        self._coverage.clear()


_process_runtime: BridgeRuntime | None = None


def get_process_runtime() -> BridgeRuntime | None:
    return _process_runtime


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
