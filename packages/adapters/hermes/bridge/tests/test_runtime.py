import os
import socket
import stat
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

from aiohttp import ClientSession

from agent_butler_bridge.runtime import (
    BridgeRuntime,
    RuntimeConfig,
    get_process_runtime,
    start_process_runtime,
    stop_process_runtime,
)


TOKEN = "runtime-test-token"


@dataclass
class FakeSendResult:
    success: bool
    message_id: str | None = None
    error: str | None = None


class FakeAdapter:
    async def send(self, chat_id, content, reply_to=None, metadata=None):
        return FakeSendResult(success=True, message_id="native-1")


class RuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.token_file = self.root / "bridge.token"
        self.token_file.write_text(TOKEN, encoding="utf-8")
        self.token_file.chmod(0o600)
        self.runtime: BridgeRuntime | None = None

    async def asyncTearDown(self) -> None:
        await stop_process_runtime()
        if self.runtime is not None:
            await self.runtime.stop()
        self.tmp.cleanup()

    def config(self, **overrides) -> RuntimeConfig:
        values = {
            "instance_id": "hermes-main",
            "host": "127.0.0.1",
            "port": 0,
            "token_file": self.token_file,
            "outbox_path": self.root / "data" / "outbox.sqlite",
        }
        values.update(overrides)
        return RuntimeConfig(**values)

    async def test_start_stop_are_idempotent_and_health_is_private(self) -> None:
        self.runtime = BridgeRuntime(self.config())

        first = await self.runtime.start()
        second = await self.runtime.start()

        self.assertIs(first, self.runtime)
        self.assertIs(second, self.runtime)
        self.assertTrue(self.runtime.started)
        self.assertGreater(self.runtime.bound_port, 0)
        self.assertEqual(
            stat.S_IMODE((self.root / "data").stat().st_mode),
            0o700,
        )
        async with ClientSession() as client:
            denied = await client.get(self.runtime.base_url + "/v1/health")
            self.assertEqual(denied.status, 401)
            accepted = await client.get(
                self.runtime.base_url + "/v1/health",
                headers={"Authorization": f"Bearer {TOKEN}"},
            )
            self.assertEqual(accepted.status, 200)
            body = await accepted.json()
        self.assertEqual(body["instanceId"], "hermes-main")
        self.assertIsNone(body["policyVersion"])
        self.assertEqual(body["coverage"]["runtime"], "ok")
        self.assertEqual(body["coverage"]["adapterAttach"], "pending")
        self.assertNotIn(TOKEN, str(body))

        await self.runtime.stop()
        await self.runtime.stop()

        self.assertFalse(self.runtime.started)
        self.assertIsNone(self.runtime.outbox)
        self.assertIsNone(self.runtime.registry)

    async def test_attach_updates_health_without_restarting_server(self) -> None:
        self.runtime = BridgeRuntime(self.config())
        await self.runtime.start()

        first = self.runtime.attach_adapter(
            FakeAdapter(),
            adapter_id="weixin:default",
            channel="weixin",
        )
        second = self.runtime.attach_adapter(
            first.adapter,
            adapter_id="weixin:default",
            channel="weixin",
        )

        self.assertIs(first, second)
        async with ClientSession() as client:
            response = await client.get(
                self.runtime.base_url + "/v1/health",
                headers={"Authorization": f"Bearer {TOKEN}"},
            )
            body = await response.json()
        self.assertTrue(body["attached"])
        self.assertEqual(body["channels"], {"weixin": "ok"})
        self.assertEqual(body["coverage"]["adapterAttach"], "ok")

    async def test_restart_clears_runtime_attachment_coverage(self) -> None:
        self.runtime = BridgeRuntime(self.config())
        await self.runtime.start()
        self.runtime.record_coverage("adapter:weixin:default:main", "ok")

        await self.runtime.stop()
        await self.runtime.start()

        coverage = self.runtime.coverage_snapshot()
        self.assertEqual(coverage["adapterAttach"], "pending")
        self.assertNotIn("adapter:weixin:default:main", coverage)

    async def test_rejects_group_or_world_readable_token_file(self) -> None:
        self.token_file.chmod(0o644)
        self.runtime = BridgeRuntime(self.config())

        with self.assertRaisesRegex(PermissionError, "0600"):
            await self.runtime.start()

        self.assertFalse(self.runtime.started)
        self.assertIsNone(self.runtime.outbox)

    async def test_rejects_non_loopback_bind_by_default(self) -> None:
        self.runtime = BridgeRuntime(self.config(host="0.0.0.0"))

        with self.assertRaisesRegex(ValueError, "loopback"):
            await self.runtime.start()

    async def test_partial_start_failure_cleans_up_and_can_retry(self) -> None:
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        occupied_port = int(listener.getsockname()[1])
        self.runtime = BridgeRuntime(self.config(port=occupied_port))

        with self.assertRaises(OSError):
            await self.runtime.start()
        self.assertFalse(self.runtime.started)
        self.assertIsNone(self.runtime.outbox)
        self.assertIsNone(self.runtime.registry)

        listener.close()
        await self.runtime.start()
        self.assertTrue(self.runtime.started)

    async def test_process_runtime_is_singleton_and_rejects_reconfiguration(self) -> None:
        config = self.config()

        first = await start_process_runtime(config)
        second = await start_process_runtime(config)

        self.runtime = first
        self.assertIs(first, second)
        self.assertIs(get_process_runtime(), first)
        with self.assertRaisesRegex(RuntimeError, "configured differently"):
            await start_process_runtime(self.config(port=9124))

        await stop_process_runtime()
        self.assertIsNone(get_process_runtime())
        self.assertFalse(first.started)
        self.runtime = None

    def test_config_from_env_uses_linux_side_defaults_and_explicit_paths(self) -> None:
        env = {
            "HOME": str(self.root),
            "HERMES_BUTLER_INSTANCE_ID": "profile-main",
            "HERMES_BUTLER_PORT": "9123",
            "HERMES_BUTLER_TOKEN_FILE": str(self.token_file),
            "HERMES_BUTLER_OUTBOX_PATH": str(self.root / "custom.sqlite"),
        }
        with patch.dict(os.environ, env, clear=True):
            config = RuntimeConfig.from_env()

        self.assertEqual(config.instance_id, "profile-main")
        self.assertEqual(config.host, "127.0.0.1")
        self.assertEqual(config.port, 9123)
        self.assertEqual(config.token_file, self.token_file)
        self.assertEqual(config.outbox_path, self.root / "custom.sqlite")
        self.assertFalse(config.allow_non_loopback)


if __name__ == "__main__":
    unittest.main()
