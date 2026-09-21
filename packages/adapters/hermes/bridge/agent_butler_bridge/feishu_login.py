"""飞书 (Feishu / Lark) OAuth 设备码流 (Device-Code Flow) 扫码登录管理器。

复刻 hermes plugins/platforms/feishu/adapter.py 中的设备码授权与轮询逻辑，
将终端 CLI 扫码逻辑封装为非阻塞的 HTTP 会话状态机：
start -> 返回 sessionId、qrUrl (即 verification_uri_complete)
后台异步轮询飞书官方平台 -> 用户在手机飞书确认后获取 client_id 与 client_secret 并自动存入 config.yaml
status -> 返回当前缓存状态
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

SESSION_TTL_SECONDS = 600.0
POLL_INTERVAL_SECONDS = 3.0

FEISHU_ACCOUNTS_URLS: Mapping[str, str] = {
    "feishu": "https://accounts.feishu.cn",
    "lark": "https://accounts.larksuite.com",
}
FEISHU_REGISTRATION_PATH = "/oauth/v1/app/registration"


class FeishuLoginConflict(RuntimeError):
    pass


class _Session:
    def __init__(self) -> None:
        self.session_id = uuid.uuid4().hex
        self.device_code = ""
        self.qr_url = ""
        self.user_code = ""
        self.domain = "feishu"
        self.interval = POLL_INTERVAL_SECONDS
        self.deadline = time.monotonic() + SESSION_TTL_SECONDS
        self.result: dict[str, Any] | None = None
        self.state: dict[str, Any] = {"state": "wait"}
        self.poller: asyncio.Task[None] | None = None


class FeishuLoginManager:
    """同一时刻仅允许一个活跃的飞书扫码会话。"""

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
                def begin(self, domain: str = "feishu") -> dict[str, Any]:
                    base_url = FEISHU_ACCOUNTS_URLS.get(domain, FEISHU_ACCOUNTS_URLS["feishu"])
                    url = f"{base_url}{FEISHU_REGISTRATION_PATH}"
                    body = {
                        "action": "begin",
                        "archetype": "PersonalAgent",
                        "auth_method": "client_secret",
                        "request_user_info": "open_id",
                    }
                    data = urlencode(body).encode("utf-8")
                    req = Request(url, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
                    with urlopen(req, timeout=15) as resp:
                        return json.loads(resp.read().decode("utf-8"))

                def poll(self, device_code: str, domain: str = "feishu") -> dict[str, Any]:
                    base_url = FEISHU_ACCOUNTS_URLS.get(domain, FEISHU_ACCOUNTS_URLS["feishu"])
                    url = f"{base_url}{FEISHU_REGISTRATION_PATH}"
                    body = {"action": "poll", "device_code": device_code, "tp": "ob_app"}
                    data = urlencode(body).encode("utf-8")
                    req = Request(url, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
                    try:
                        with urlopen(req, timeout=15) as resp:
                            return json.loads(resp.read().decode("utf-8"))
                    except HTTPError as exc:
                        raw = exc.read()
                        if raw:
                            try:
                                return json.loads(raw.decode("utf-8"))
                            except Exception:
                                pass
                        raise

            self._api: Any = _DefaultApi()
        else:
            self._api = api

        if saver is None:
            from .channel_control import ChannelControl

            self._saver: Callable[[dict[str, str]], None] = (
                lambda creds: ChannelControl().update_config("feishu", creds)
            )
        else:
            self._saver = saver

    async def start(self, domain: str = "feishu") -> dict[str, Any]:
        async with self._lock:
            live = [s for s in self._sessions.values() if self._live(s)]
            if live:
                raise FeishuLoginConflict("another feishu login session is active")
            self._sessions = {k: v for k, v in self._sessions.items() if self._live(v)}

            res = await asyncio.to_thread(self._api.begin, domain)
            device_code = res.get("device_code")
            if not device_code:
                raise RuntimeError("Feishu registration did not return device_code: " + str(res))

            qr_url = res.get("verification_uri_complete") or res.get("user_code") or ""
            if qr_url and "from=" not in qr_url:
                qr_url += ("&" if "?" in qr_url else "?") + "from=hermes&tp=hermes"

            interval = float(res.get("interval") or self._poll_interval)
            expire_in = float(res.get("expire_in") or self._timeout_seconds)

            session = _Session()
            session.device_code = device_code
            session.qr_url = qr_url
            session.user_code = str(res.get("user_code") or "")
            session.domain = domain
            session.interval = max(interval, 1.0)
            session.deadline = time.monotonic() + min(expire_in, self._timeout_seconds)
            session.state = {"state": "wait", "qrUrl": session.qr_url}
            self._sessions[session.session_id] = session

            return {
                "sessionId": session.session_id,
                "qrUrl": session.qr_url,
                "expiresAt": (
                    datetime.now(timezone.utc) + timedelta(seconds=min(expire_in, self._timeout_seconds))
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
            res = await asyncio.to_thread(self._api.poll, session.device_code, session.domain)
        except Exception:
            if time.monotonic() > session.deadline:
                session.result = {"state": "failed", "reason": "timeout"}
            else:
                session.state = {"state": "wait", "qrUrl": session.qr_url}
            return self._settle(session)

        client_id = res.get("client_id")
        client_secret = res.get("client_secret")
        if client_id and client_secret:
            try:
                self._saver({"app_id": client_id, "app_secret": client_secret})
                session.result = {
                    "state": "confirmed",
                    "account": client_id,
                    "suggestEnable": True,
                }
            except Exception as exc:
                session.result = {"state": "failed", "reason": f"save credentials failed: {exc}"}
            return self._settle(session)

        err = str(res.get("error") or "")
        if err in {"access_denied", "expired_token"}:
            session.result = {"state": "failed", "reason": err}
        elif time.monotonic() > session.deadline:
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
                await asyncio.sleep(session.interval)
        except asyncio.CancelledError:
            pass

    @staticmethod
    def _live(session: _Session) -> bool:
        return session.result is None and time.monotonic() <= session.deadline
