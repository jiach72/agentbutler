"""QQ 机器人 (QQBot) 扫码配置 (Bind-Task) 管理器。

复刻 hermes gateway/platforms/qqbot/onboard.py 中的绑定任务与轮询解密逻辑，
封装为非阻塞 HTTP 会话状态机：
start -> 创建 bind_task，生成 AES key，返回 sessionId 与二维码链接
后台异步轮询 q.qq.com 官方平台 -> 用户在手机 QQ 确认授权后，解密 client_secret 并自动写入 config.yaml
status -> 返回当前缓存状态
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from urllib.parse import quote
from urllib.request import Request, urlopen

SESSION_TTL_SECONDS = 600.0
POLL_INTERVAL_SECONDS = 2.0
MAX_QR_REFRESH = 3

DEFAULT_PORTAL_HOST = "q.qq.com"
ONBOARD_CREATE_PATH = "/lite/create_bind_task"
ONBOARD_POLL_PATH = "/lite/poll_bind_result"
QR_URL_TEMPLATE = "https://q.qq.com/qqbot/openclaw/connect.html?task_id={task_id}&_wv=2&source=hermes"


def generate_bind_key() -> str:
    """生成 256 位随机 AES 密钥并以 base64 编码。"""
    return base64.b64encode(os.urandom(32)).decode()


def decrypt_secret(encrypted_base64: str, key_base64: str) -> str:
    """AES-256-GCM 解密腾讯服务端加密回传的 client_secret。"""
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        raw = base64.b64decode(encrypted_base64)
        return AESGCM(base64.b64decode(key_base64)).decrypt(raw[:12], raw[12:], None).decode("utf-8")
    except Exception as exc:
        raise RuntimeError(f"QQBot decrypt secret failed: {exc}") from exc


class QqbotLoginConflict(RuntimeError):
    pass


class _Session:
    def __init__(self) -> None:
        self.session_id = uuid.uuid4().hex
        self.task_id = ""
        self.aes_key = ""
        self.qr_url = ""
        self.refresh_count = 0
        self.deadline = time.monotonic() + SESSION_TTL_SECONDS
        self.result: dict[str, Any] | None = None
        self.state: dict[str, Any] = {"state": "wait"}
        self.poller: asyncio.Task[None] | None = None


class QqbotLoginManager:
    """同一时刻仅允许一个活跃的 QQ 机器人扫码绑定会话。"""

    def __init__(
        self,
        *,
        api: Any | None = None,
        saver: Callable[[dict[str, str]], None] | None = None,
        timeout_seconds: float = SESSION_TTL_SECONDS,
        poll_interval_seconds: float = POLL_INTERVAL_SECONDS,
    ) -> None:
        self._sessions: dict[str, _Session] = {}
        self._lock = asyncio.Lock()
        self._timeout_seconds = timeout_seconds
        self._poll_interval = poll_interval_seconds

        if api is None:
            class _DefaultApi:
                def __init__(self) -> None:
                    self.host = os.getenv("QQ_PORTAL_HOST", DEFAULT_PORTAL_HOST)

                def create_task(self, key: str) -> str:
                    url = f"https://{self.host}{ONBOARD_CREATE_PATH}"
                    payload = json.dumps({"key": key}).encode("utf-8")
                    req = Request(
                        url,
                        data=payload,
                        headers={
                            "Content-Type": "application/json",
                            "Accept": "application/json",
                            "User-Agent": "AgentButler/1.0",
                        },
                    )
                    with urlopen(req, timeout=10) as resp:
                        data = json.loads(resp.read().decode("utf-8"))
                    if data.get("retcode") != 0:
                        raise RuntimeError(data.get("msg", "create_bind_task failed"))
                    task_id = (data.get("data") or {}).get("task_id")
                    if not task_id:
                        raise RuntimeError("missing task_id in response")
                    return str(task_id)

                def poll_result(self, task_id: str) -> tuple[int, str, str, str]:
                    """返回 (status: 0=none, 1=pending, 2=completed, 3=expired, bot_appid, bot_encrypt_secret, user_openid)"""
                    url = f"https://{self.host}{ONBOARD_POLL_PATH}"
                    payload = json.dumps({"task_id": task_id}).encode("utf-8")
                    req = Request(
                        url,
                        data=payload,
                        headers={
                            "Content-Type": "application/json",
                            "Accept": "application/json",
                            "User-Agent": "AgentButler/1.0",
                        },
                    )
                    with urlopen(req, timeout=10) as resp:
                        data = json.loads(resp.read().decode("utf-8"))
                    if data.get("retcode") != 0:
                        raise RuntimeError(data.get("msg", "poll_bind_result failed"))
                    d = data.get("data") or {}
                    return (
                        int(d.get("status", 0)),
                        str(d.get("bot_appid") or ""),
                        str(d.get("bot_encrypt_secret") or ""),
                        str(d.get("user_openid") or ""),
                    )

            self._api: Any = _DefaultApi()
        else:
            self._api = api

        if saver is None:
            from .channel_control import ChannelControl

            self._saver: Callable[[dict[str, str]], None] = (
                lambda creds: ChannelControl().update_config("qqbot", creds)
            )
        else:
            self._saver = saver

    async def start(self) -> dict[str, Any]:
        async with self._lock:
            live = [s for s in self._sessions.values() if self._live(s)]
            if live:
                raise QqbotLoginConflict("another qqbot login session is active")
            self._sessions = {k: v for k, v in self._sessions.items() if self._live(v)}

            session = _Session()
            session.deadline = time.monotonic() + self._timeout_seconds
            await self._refresh_task(session)
            session.state = {"state": "wait", "qrUrl": session.qr_url}
            self._sessions[session.session_id] = session

            return {
                "sessionId": session.session_id,
                "qrUrl": session.qr_url,
                "expiresAt": (
                    datetime.now(timezone.utc) + timedelta(seconds=self._timeout_seconds)
                )
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z"),
            }

    def status(self, session_id: str) -> dict[str, Any]:
        session = self._sessions.get(session_id)
        if session is None:
            return {"state": "failed", "reason": "session expired"}
        if session.result is not None:
            return dict(session.result)
        if time.monotonic() > session.deadline:
            session.result = {"state": "failed", "reason": "timeout"}
            self._stop_poller(session)
            return dict(session.result)
        if session.poller is None:
            try:
                asyncio.get_running_loop()
            except RuntimeError:
                return dict(session.state)
            session.poller = asyncio.create_task(self._poll_loop(session))
        return dict(session.state)

    async def poll_once(self, session_id: str) -> dict[str, Any]:
        session = self._sessions.get(session_id)
        if session is None or not self._live(session):
            return {"state": "failed", "reason": "session expired"}

        try:
            status_code, app_id, encrypted_secret, user_openid = await asyncio.to_thread(
                self._api.poll_result, session.task_id
            )
        except Exception:
            if time.monotonic() > session.deadline:
                session.result = {"state": "failed", "reason": "timeout"}
            else:
                session.state = {"state": "wait", "qrUrl": session.qr_url}
            return self._settle(session)

        # status_code: 0=NONE, 1=PENDING, 2=COMPLETED, 3=EXPIRED
        if status_code == 2:  # COMPLETED
            try:
                client_secret = decrypt_secret(encrypted_secret, session.aes_key)
                self._saver({"app_id": app_id, "client_secret": client_secret})
                session.result = {
                    "state": "confirmed",
                    "account": app_id,
                    "suggestEnable": True,
                }
            except Exception as exc:
                session.result = {"state": "failed", "reason": f"decrypt or save failed: {exc}"}
            return self._settle(session)

        if status_code == 3:  # EXPIRED
            session.refresh_count += 1
            if session.refresh_count > MAX_QR_REFRESH:
                session.result = {"state": "failed", "reason": "qr expired repeatedly"}
            else:
                try:
                    await self._refresh_task(session)
                    session.state = {
                        "state": "expired_refreshing",
                        "qrUrl": session.qr_url,
                    }
                except Exception as exc:
                    session.result = {"state": "failed", "reason": f"refresh qr failed: {exc}"}
            return self._settle(session)

        if time.monotonic() > session.deadline:
            session.result = {"state": "failed", "reason": "timeout"}
        else:
            session.state = {"state": "wait", "qrUrl": session.qr_url}

        return self._settle(session)

    def cancel(self, session_id: str) -> bool:
        session = self._sessions.pop(session_id, None)
        if session is None:
            return False
        self._stop_poller(session)
        return True

    def _settle(self, session: _Session) -> dict[str, Any]:
        if session.result is not None:
            self._stop_poller(session)
            return dict(session.result)
        return dict(session.state)

    @staticmethod
    def _stop_poller(session: _Session) -> None:
        if session.poller is not None and not session.poller.done():
            session.poller.cancel()
        session.poller = None

    async def _poll_loop(self, session: _Session) -> None:
        try:
            while self._live(session):
                await self.poll_once(session.session_id)
                if session.result is not None:
                    break
                await asyncio.sleep(self._poll_interval)
        except asyncio.CancelledError:
            pass

    async def _refresh_task(self, session: _Session) -> None:
        key = generate_bind_key()
        task_id = await asyncio.to_thread(self._api.create_task, key)
        session.task_id = task_id
        session.aes_key = key
        session.qr_url = QR_URL_TEMPLATE.format(task_id=quote(task_id))

    @staticmethod
    def _live(session: _Session) -> bool:
        return session.result is None and time.monotonic() <= session.deadline
