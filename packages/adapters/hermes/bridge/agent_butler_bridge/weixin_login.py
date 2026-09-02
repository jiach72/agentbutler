"""微信 iLink 扫码登录的 HTTP 会话：复刻 hermes weixin.qr_login 的轮询语义。

iLink 的 get_qrcode_status 是约 30 秒的服务端长轮询；面板按秒轮询本端点，
因此每个会话用后台任务持续驱动 iLink 轮询，status() 只即时返回缓存的最新状态。
"""

from __future__ import annotations

import asyncio
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

SESSION_TTL_SECONDS = 300.0
MAX_QR_REFRESH = 3
POLL_INTERVAL_SECONDS = 1.0
# 与 hermes gateway/platforms/weixin.py 的 iLink 常量保持一致。
ILINK_BASE_URL = "https://ilinkai.weixin.qq.com"
EP_GET_BOT_QR = "ilink/bot/get_bot_qrcode"
EP_GET_QR_STATUS = "ilink/bot/get_qrcode_status"
QR_TIMEOUT_MS = 35_000


class WeixinLoginConflict(RuntimeError):
    pass


class _Session:
    def __init__(self) -> None:
        self.session_id = uuid.uuid4().hex
        self.qrcode_value = ""
        self.qrcode_url = ""
        self.base_url = ILINK_BASE_URL
        self.refresh_count = 0
        self.deadline = time.monotonic() + SESSION_TTL_SECONDS
        self.result: dict[str, Any] | None = None
        self.state: dict[str, Any] = {"state": "wait"}
        self.poller: asyncio.Task[None] | None = None


class WeixinLoginManager:
    """同一时刻仅允许一个扫码会话；会话在进程内存中，Bridge 重启即失效。"""

    def __init__(
        self,
        *,
        api: Any | None = None,
        saver: Callable[[dict[str, str]], None] | None = None,
        timeout_seconds: float = SESSION_TTL_SECONDS,
    ) -> None:
        self._sessions: dict[str, _Session] = {}
        self._lock = asyncio.Lock()
        self._timeout_seconds = timeout_seconds
        if api is None:
            from gateway.platforms.weixin import (
                EP_GET_BOT_QR,
                EP_GET_QR_STATUS,
                QR_TIMEOUT_MS,
                _api_get,
                _make_ssl_connector,
            )
            import aiohttp

            class _DefaultApi:
                async def fetch_qr(self) -> dict[str, Any]:
                    async with aiohttp.ClientSession(trust_env=True, connector=_make_ssl_connector()) as session:
                        return await _api_get(
                            session,
                            base_url=ILINK_BASE_URL,
                            endpoint=f"{EP_GET_BOT_QR}?bot_type=3",
                            timeout_ms=QR_TIMEOUT_MS,
                        )

                async def poll_status(self, qrcode_value: str, base_url: str) -> dict[str, Any]:
                    async with aiohttp.ClientSession(trust_env=True, connector=_make_ssl_connector()) as session:
                        return await _api_get(
                            session,
                            base_url=base_url,
                            endpoint=f"{EP_GET_QR_STATUS}?qrcode={qrcode_value}",
                            timeout_ms=QR_TIMEOUT_MS,
                        )

            self._api: Any = _DefaultApi()
        else:
            self._api = api
        if saver is None:
            from gateway.platforms.weixin import save_weixin_account
            import os

            home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
            self._saver: Callable[[dict[str, str]], None] = lambda account: save_weixin_account(home, **account)
        else:
            self._saver = saver

    async def start(self) -> dict[str, Any]:
        async with self._lock:
            live = [s for s in self._sessions.values() if self._live(s)]
            if live:
                raise WeixinLoginConflict("another weixin login session is active")
            self._sessions = {k: v for k, v in self._sessions.items() if self._live(v)}
            session = _Session()
            session.deadline = time.monotonic() + self._timeout_seconds
            await self._refresh_qr(session)
            session.state = {"state": "wait", "qrValue": session.qrcode_value, "qrUrl": session.qrcode_url}
            self._sessions[session.session_id] = session
            return {
                "sessionId": session.session_id,
                "qrValue": session.qrcode_value,
                "qrUrl": session.qrcode_url,
                "expiresAt": (
                    datetime.now(timezone.utc) + timedelta(seconds=self._timeout_seconds)
                )
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z"),
            }

    def status(self, session_id: str) -> dict[str, Any]:
        """即时返回缓存状态；在生产事件循环里懒启动后台轮询任务。"""
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
                return dict(session.state)  # 无运行中的事件循环（单测）：由 poll_once 显式驱动
            session.poller = asyncio.create_task(self._poll_loop(session))
        return dict(session.state)

    async def poll_once(self, session_id: str) -> dict[str, Any]:
        """驱动一次 iLink 轮询并更新缓存状态；测试与后台轮询共用。"""
        session = self._sessions.get(session_id)
        if session is None or not self._live(session):
            return {"state": "failed", "reason": "session expired"}
        try:
            payload = await self._api.poll_status(session.qrcode_value, session.base_url)
        except Exception:
            if time.monotonic() > session.deadline:
                session.result = {"state": "failed", "reason": "timeout"}
            elif session.refresh_count >= MAX_QR_REFRESH:
                # 刷新额度已耗尽且轮询仍无进展：判定失败，而不是永远 wait。
                session.result = {"state": "failed", "reason": "qr expired repeatedly"}
            else:
                session.state = {"state": "wait"}
            return self._settle(session)
        state = str(payload.get("status") or "wait")
        if state == "scaned_but_redirect":
            redirect = str(payload.get("redirect_host") or "")
            if redirect:
                session.base_url = f"https://{redirect}"
            session.state = {"state": "wait"}
        elif state == "scaned":
            session.state = {"state": "scanned"}
        elif state == "expired":
            session.refresh_count += 1
            if session.refresh_count > MAX_QR_REFRESH:
                session.result = {"state": "failed", "reason": "qr expired repeatedly"}
            else:
                await self._refresh_qr(session)
                session.state = {
                    "state": "expired_refreshing",
                    "qrValue": session.qrcode_value,
                    "qrUrl": session.qrcode_url,
                }
        elif state == "confirmed":
            account_id = str(payload.get("ilink_bot_id") or "")
            token = str(payload.get("bot_token") or "")
            if not account_id or not token:
                session.result = {"state": "failed", "reason": "incomplete credentials"}
            else:
                account = {
                    "account_id": account_id,
                    "token": token,
                    "base_url": str(payload.get("baseurl") or ILINK_BASE_URL),
                    "user_id": str(payload.get("ilink_user_id") or ""),
                }
                self._saver(account)
                session.result = {
                    "state": "confirmed",
                    "account": account_id,
                    "suggestEnable": True,
                }
        elif time.monotonic() > session.deadline:
            session.result = {"state": "failed", "reason": "timeout"}
        else:
            session.state = {"state": "wait"}
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
                await asyncio.sleep(POLL_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            pass

    async def _refresh_qr(self, session: _Session) -> None:
        payload = await self._api.fetch_qr()
        session.qrcode_value = str(payload.get("qrcode") or "")
        session.qrcode_url = str(payload.get("qrcode_img_content") or "")

    @staticmethod
    def _live(session: _Session) -> bool:
        return session.result is None and time.monotonic() <= session.deadline
