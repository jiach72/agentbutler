"""Authentication middleware for the localhost Bridge API."""

from __future__ import annotations

import hmac
from collections.abc import Awaitable, Callable

from aiohttp import web


BRIDGE_PROTOCOL_VERSION = "1"


def bearer_auth_middleware(token: str):
    if not token:
        raise ValueError("Bridge bearer token must not be empty")

    @web.middleware
    async def middleware(
        request: web.Request,
        handler: Callable[[web.Request], Awaitable[web.StreamResponse]],
    ) -> web.StreamResponse:
        authorization = request.headers.get("Authorization", "")
        prefix = "Bearer "
        supplied = authorization[len(prefix) :] if authorization.startswith(prefix) else ""
        if not supplied or not hmac.compare_digest(supplied, token):
            response = web.json_response(
                {"error": "unauthorized", "detail": "valid bearer token required"},
                status=401,
            )
        else:
            response = await handler(request)
        response.headers["X-Butler-Bridge-Version"] = BRIDGE_PROTOCOL_VERSION
        return response

    return middleware
