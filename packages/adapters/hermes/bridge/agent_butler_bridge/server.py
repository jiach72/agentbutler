"""Authenticated localhost HTTP API for the Hermes Butler Bridge."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any, Mapping

from aiohttp import web

from .auth import bearer_auth_middleware
from .outbox import Outbox
from .registry import NativeRegistry


BRIDGE_VERSION = "1.0.0-beta.26"
PROTOCOL_VERSION = 1
MAX_BODY_BYTES = 1024 * 1024


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _error(status: int, code: str, detail: str) -> web.Response:
    return web.json_response({"error": code, "detail": detail}, status=status)


async def _read_object(
    request: web.Request,
    *,
    required: set[str],
    allowed: set[str],
) -> dict[str, Any]:
    try:
        payload = await request.json()
    except Exception as exc:
        raise ValueError("request body must be valid JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("request body must be a JSON object")
    missing = sorted(required - set(payload))
    extra = sorted(set(payload) - allowed)
    if missing:
        raise ValueError(f"missing fields: {', '.join(missing)}")
    if extra:
        raise ValueError(f"unsupported fields: {', '.join(extra)}")
    return payload


def _conflict_or_invalid(exc: ValueError) -> web.Response:
    detail = str(exc)
    conflict_markers = (
        "hash",
        "terminal",
        "already",
        "active attempt",
        "decision id conflict",
        "delivery_unknown",
        "cannot enter dead_letter",
    )
    if any(marker in detail for marker in conflict_markers):
        return _error(409, "conflict", detail)
    return _error(400, "invalid", detail)


def create_app(
    outbox: Outbox,
    registry: NativeRegistry,
    *,
    token: str,
    instance_id: str,
    coverage_provider: Callable[[], Mapping[str, str]] | None = None,
    started_at_provider: Callable[[], str | None] | None = None,
    channel_control: Any | None = None,
    channel_status_provider: Callable[[], Mapping[str, Any]] | None = None,
    weixin_login: Any | None = None,
) -> web.Application:
    app = web.Application(
        client_max_size=MAX_BODY_BYTES,
        middlewares=[bearer_auth_middleware(token)],
    )

    async def health(_request: web.Request) -> web.Response:
        channels = registry.attached_channels()
        policy = outbox.get_policy_snapshot()
        coverage = {} if coverage_provider is None else dict(coverage_provider())
        return web.json_response(
            {
                "protocolVersion": PROTOCOL_VERSION,
                "bridgeVersion": BRIDGE_VERSION,
                "instanceId": instance_id,
                "attached": bool(channels),
                "outboxWritable": outbox.is_writable(),
                "policyVersion": None if policy is None else policy["version"],
                "channels": channels,
                "coverage": coverage,
                "startedAt": None if started_at_provider is None else started_at_provider(),
                "channelStatus": None if channel_status_provider is None else channel_status_provider(),
            }
        )

    async def channels_directory(_request: web.Request) -> web.Response:
        if channel_control is None:
            return _error(404, "not_found", "channel control unavailable")
        return web.json_response(channel_control.directory(registry))

    async def install_policy(request: web.Request) -> web.Response:
        try:
            payload = await _read_object(
                request,
                required={"version", "sha256", "payload"},
                allowed={"version", "sha256", "payload"},
            )
            version = payload["version"]
            sha256 = payload["sha256"]
            body = payload["payload"]
            if not isinstance(version, str) or not isinstance(sha256, str) or not isinstance(body, Mapping):
                raise ValueError("version/sha256 must be strings and payload must be an object")
            outbox.set_policy_snapshot(version, sha256, body)
            return web.json_response(
                {"version": version, "sha256": sha256, "appliedAt": _utc_now()}
            )
        except ValueError as exc:
            return _conflict_or_invalid(exc)

    async def changes(request: web.Request) -> web.Response:
        try:
            after = int(request.query.get("after", "0"))
            limit = int(request.query.get("limit", "100"))
            return web.json_response(outbox.list_changes(after, limit))
        except (TypeError, ValueError) as exc:
            return _error(400, "invalid", str(exc))

    async def decide(request: web.Request) -> web.Response:
        route_message_id = request.match_info["message_id"]
        try:
            payload = await _read_object(
                request,
                required={
                    "decisionId",
                    "messageId",
                    "expectedContentSha256",
                    "state",
                    "transformTrace",
                    "policyVersion",
                    "reason",
                },
                allowed={
                    "decisionId",
                    "messageId",
                    "expectedContentSha256",
                    "state",
                    "availableAt",
                    "optimizedContent",
                    "transformTrace",
                    "policyVersion",
                    "reason",
                },
            )
            if payload["messageId"] != route_message_id:
                raise ValueError("messageId does not match route")
            decision_id = payload["decisionId"]
            if not isinstance(decision_id, str) or not decision_id:
                raise ValueError("decisionId must be a non-empty string")
            trace = payload["transformTrace"]
            if not isinstance(trace, list) or not all(isinstance(item, str) for item in trace):
                raise ValueError("transformTrace must be a string array")
            row = outbox.apply_decision(
                route_message_id,
                decision_id,
                str(payload["expectedContentSha256"]),
                str(payload["state"]),
                payload.get("availableAt"),
                trace,
                str(payload["policyVersion"]),
                str(payload["reason"]),
                payload.get("optimizedContent"),
            )
            return web.json_response(row)
        except KeyError:
            return _error(404, "not_found", "message not found")
        except ValueError as exc:
            return _conflict_or_invalid(exc)

    async def dead_letter(request: web.Request) -> web.Response:
        route_message_id = request.match_info["message_id"]
        try:
            payload = await _read_object(
                request,
                required={"messageId", "expectedContentSha256", "reason"},
                allowed={"messageId", "expectedContentSha256", "reason"},
            )
            if payload["messageId"] != route_message_id:
                raise ValueError("messageId does not match route")
            row = outbox.mark_dead_letter(
                route_message_id,
                str(payload["expectedContentSha256"]),
                str(payload["reason"]),
            )
            return web.json_response(row)
        except KeyError:
            return _error(404, "not_found", "message not found")
        except ValueError as exc:
            return _conflict_or_invalid(exc)

    async def deliver(request: web.Request) -> web.Response:
        try:
            payload = await _read_object(
                request,
                required={"messageId", "attemptId", "expectedContentSha256"},
                allowed={"messageId", "attemptId", "expectedContentSha256"},
            )
            ack = await registry.deliver(
                str(payload["messageId"]),
                str(payload["attemptId"]),
                str(payload["expectedContentSha256"]),
            )
            return web.json_response(ack)
        except KeyError:
            return _error(404, "not_found", "message not found")
        except ValueError as exc:
            return _conflict_or_invalid(exc)
        except RuntimeError as exc:
            return _error(503, "unavailable", str(exc))

    async def inbound_decision(request: web.Request) -> web.Response:
        inbound_id = request.match_info["inbound_id"]
        try:
            payload = await _read_object(
                request,
                required={"inboundMessageId", "action", "optimizedText", "transformTrace"},
                allowed={"inboundMessageId", "action", "optimizedText", "transformTrace", "changes", "mode"},
            )
            return web.json_response(outbox.apply_inbound_decision(inbound_id, payload))
        except KeyError:
            return _error(404, "not_found", "inbound message not found")
        except ValueError as exc:
            return _conflict_or_invalid(exc)

    async def inbound_history(request: web.Request) -> web.Response:
        try:
            limit = int(request.query.get("limit", "50"))
            if limit < 1 or limit > 200:
                raise ValueError("limit must be between 1 and 200")
            return web.json_response(outbox.list_inbound_history(limit))
        except (TypeError, ValueError) as exc:
            return _error(400, "invalid", str(exc))
    async def prewarm(request: web.Request) -> web.Response:
        try:
            payload = await _read_object(
                request,
                required={"channel"},
                allowed={"channel"},
            )
            channel = payload["channel"]
            if not isinstance(channel, str) or not channel:
                raise ValueError("channel must be a non-empty string")
            return web.json_response(await registry.prewarm(channel))
        except ValueError as exc:
            return _conflict_or_invalid(exc)

    async def task(request: web.Request) -> web.Response:
        run_id = request.match_info["run_id"]
        view = outbox.task_view(run_id)
        if view is None:
            return _error(404, "not_found", "task not found")
        return web.json_response(view)

    async def weixin_login_start(_request: web.Request) -> web.Response:
        if weixin_login is None:
            return _error(404, "not_found", "weixin login unavailable")
        try:
            return web.json_response(await weixin_login.start())
        except ValueError as exc:
            return _conflict_or_invalid(exc)
        except Exception as exc:
            return _error(409, "conflict", str(exc))

    async def weixin_login_status(request: web.Request) -> web.Response:
        if weixin_login is None:
            return _error(404, "not_found", "weixin login unavailable")
        session_id = request.query.get("sessionId", "")
        if not session_id:
            return _error(400, "invalid", "sessionId is required")
        return web.json_response(weixin_login.status(session_id))

    async def weixin_login_cancel(request: web.Request) -> web.Response:
        if weixin_login is None:
            return _error(404, "not_found", "weixin login unavailable")
        try:
            payload = await _read_object(request, required={"sessionId"}, allowed={"sessionId"})
        except ValueError as exc:
            return _conflict_or_invalid(exc)
        return web.json_response({"cancelled": weixin_login.cancel(str(payload["sessionId"]))})

    async def channel_schema(request: web.Request) -> web.Response:
        if channel_control is None:
            return _error(404, "not_found", "channel control unavailable")
        try:
            return web.json_response(channel_control.schema(request.match_info["channel"]))
        except ValueError as exc:
            return _error(400, "invalid", str(exc))

    async def channel_config_put(request: web.Request) -> web.Response:
        if channel_control is None:
            return _error(404, "not_found", "channel control unavailable")
        channel = request.match_info["channel"]
        try:
            fields = channel_control.schema(channel)["fields"]
            allowed = {field["name"] for field in fields}
            payload = await _read_object(request, required=set(), allowed=allowed)
            values = {key: str(value) for key, value in payload.items() if str(value).strip() != ""}
            saved = channel_control.update_config(channel, values)
            return web.json_response({"saved": True, **saved})
        except ValueError as exc:
            return _error(400, "invalid", str(exc))

    async def channel_enable(request: web.Request) -> web.Response:
        if channel_control is None:
            return _error(404, "not_found", "channel control unavailable")
        channel = request.match_info["channel"]
        try:
            result = channel_control.set_enabled(channel, True)
        except ValueError as exc:
            return _error(400, "invalid", str(exc))
        return web.json_response({"restarting": channel_control.request_restart(registry), **result})

    async def channel_disable(request: web.Request) -> web.Response:
        if channel_control is None:
            return _error(404, "not_found", "channel control unavailable")
        channel = request.match_info["channel"]
        try:
            result = channel_control.set_enabled(channel, False)
        except ValueError as exc:
            return _error(400, "invalid", str(exc))
        return web.json_response({"restarting": channel_control.request_restart(registry), **result})

    app.router.add_get("/v1/health", health)
    app.router.add_get("/v1/channels", channels_directory)
    app.router.add_post("/v1/channels/weixin/login/start", weixin_login_start)
    app.router.add_get("/v1/channels/weixin/login/status", weixin_login_status)
    app.router.add_post("/v1/channels/weixin/login/cancel", weixin_login_cancel)
    app.router.add_get("/v1/channels/{channel}/schema", channel_schema)
    app.router.add_put("/v1/channels/{channel}/config", channel_config_put)
    app.router.add_post("/v1/channels/{channel}/enable", channel_enable)
    app.router.add_post("/v1/channels/{channel}/disable", channel_disable)
    app.router.add_post("/v1/policy", install_policy)
    app.router.add_get("/v1/outbox/changes", changes)
    app.router.add_post("/v1/outbox/{message_id}/decision", decide)
    app.router.add_post("/v1/outbox/{message_id}/dead-letter", dead_letter)
    app.router.add_post("/v1/deliver", deliver)
    app.router.add_post("/v1/inbound/{inbound_id}/decision", inbound_decision)
    app.router.add_get("/v1/inbound/history", inbound_history)
    app.router.add_post("/v1/prewarm", prewarm)
    app.router.add_get("/v1/tasks/{run_id}", task)
    return app
