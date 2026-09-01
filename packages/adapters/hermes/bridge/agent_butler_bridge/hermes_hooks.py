"""Narrow integration helpers called by managed Hermes runtime patches."""

from __future__ import annotations

import asyncio
import copy
import functools
import inspect
from .message_optimizer import optimize_inbound
from .llm_optimizer import optimize_with_llm, summarize_task_with_llm
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping

from .context import (
    RunLifecycleState,
    mark_current_run_failed,
    message_context,
    run_lifecycle_scope,
)
from .ids import uuid7
from .relay import RELAY_PASSTHROUGH, relay_mode
from .registry import AdapterBinding
from .runtime import (
    BridgeRuntime,
    get_process_runtime,
    start_process_runtime,
    stop_process_runtime,
)
from .wrapper import attach_adapter, capture_inline_response


CHANNEL_ALIASES = {
    "api_server": "api-server",
    "api-server": "api-server",
    "weixin": "weixin",
    "a2a": "a2a",
}

# Hermes may schedule its assembled answer on the event loop just after the
# background turn returns. Keep the run in ``completing`` long enough for that
# late capture to land before we choose the terminal report.
TASK_RESULT_SETTLE_DELAY_SECONDS = 0.05
TASK_RESULT_SETTLE_TIMEOUT_SECONDS = 0.75

@dataclass
class HookSendResult:
    success: bool
    message_id: str | None = None
    error: str | None = None


def install_base_platform_hooks(
    base_class: type,
    *,
    runtime_provider=get_process_runtime,
) -> None:
    """Install inbound and per-message lifecycle hooks on Hermes' base adapter."""

    if getattr(base_class, "_agent_butler_base_hooks_v1", False):
        return
    original_handle = base_class.handle_message
    original_process = base_class._process_message_background

    @functools.wraps(original_handle)
    async def managed_handle(adapter, event, *args, **kwargs):
        runtime, binding = _require_runtime_binding(adapter, runtime_provider)
        _inbound_id, deduped = await _record_inbound(runtime, binding, event)
        runtime.record_coverage("inbound", "ok")
        if deduped:
            return None
        return await original_handle(adapter, event, *args, **kwargs)

    @functools.wraps(original_process)
    async def managed_process(adapter, event, session_key, *args, **kwargs):
        runtime, binding = _require_runtime_binding(adapter, runtime_provider)
        # 无论 inbound_id 是否已由 handle_message 写入，都要等待同一决策落库，
        # 否则后续处理会在规则/LLM 优化完成前拿到原始文本，产生竞态。
        inbound_id, _deduped = await _record_inbound(
            runtime,
            binding,
            event,
            wait_for_decision=True,
        )
        started = runtime.outbox.begin_run(
            session_id=str(session_key),
            inbound_message_id=inbound_id,
        )
        run_id = started["run"]["runId"]
        source = getattr(event, "source", None)
        runner = getattr(adapter, "gateway_runner", None)
        active_runs = _active_run_map(runner, create=True)
        context_updates = _binding_context(
            runtime,
            binding,
            chat_id=getattr(source, "chat_id", None),
            thread_id=getattr(source, "thread_id", None),
            session_id=str(session_key),
            run_id=run_id,
            inbound_message_id=inbound_id,
        )
        with run_lifecycle_scope(run_id) as lifecycle:
            if active_runs is not None:
                active_runs[str(session_key)] = lifecycle
            try:
                with message_context(**context_updates):
                    optimized_event = (
                        event
                        if relay_mode(runtime.outbox) == RELAY_PASSTHROUGH
                        else _apply_inbound_optimization(runtime, inbound_id, event)
                    )
                    await _capture_task_receipt(adapter, binding, runtime, source, run_id)
                    await original_process(adapter, optimized_event, session_key, *args, **kwargs)
            except BaseException:
                with lifecycle.lock:
                    lifecycle.failed = True
                raise
            finally:
                try:
                    await _finalize_task_result(runtime, binding, run_id, failed=lifecycle.failed)
                except Exception:
                    # Reporting must never prevent the terminal lifecycle event from being
                    # committed; the raw result remains available for Bridge delivery.
                    runtime.record_coverage("taskSummary", "degraded")
                finally:
                    runtime.outbox.finish_run(run_id, failed=lifecycle.failed)
                if active_runs is not None and active_runs.get(str(session_key)) is lifecycle:
                    active_runs.pop(str(session_key), None)
                runtime.record_coverage("runLifecycle", "ok")

    base_class.handle_message = managed_handle
    base_class._process_message_background = managed_process
    base_class._agent_butler_base_hooks_v1 = True


def install_gateway_runtime_hooks(
    gateway_runner_class: type,
    turn_runner_class: type,
    *,
    runtime_provider=get_process_runtime,
    runtime_starter=start_process_runtime,
    runtime_stopper=stop_process_runtime,
) -> None:
    """Install Bridge lifecycle, adapter attach, turn failure, and progress hooks."""

    if not getattr(gateway_runner_class, "_agent_butler_gateway_hooks_v1", False):
        original_start = gateway_runner_class.start
        original_stop = gateway_runner_class.stop
        original_connect = gateway_runner_class._connect_adapter_with_timeout
        original_run_agent = gateway_runner_class._run_agent_inner

        @functools.wraps(original_start)
        async def managed_start(runner, *args, **kwargs):
            runtime = await runtime_starter()
            runner._agent_butler_runtime = runtime
            try:
                return await original_start(runner, *args, **kwargs)
            except BaseException:
                await runtime_stopper()
                raise

        @functools.wraps(original_stop)
        async def managed_stop(runner, *args, **kwargs):
            try:
                return await original_stop(runner, *args, **kwargs)
            finally:
                await runtime_stopper()
                runner._agent_butler_runtime = None

        @functools.wraps(original_connect)
        async def managed_connect(runner, adapter, platform, *args, **kwargs):
            connected = await original_connect(runner, adapter, platform, *args, **kwargs)
            if connected:
                runtime = runtime_provider()
                if runtime is None:
                    runtime = getattr(runner, "_agent_butler_runtime", None)
                profile = getattr(adapter, "_owner_profile", None)
                if not isinstance(profile, str) or not profile.strip():
                    profile_getter = getattr(runner, "_active_profile_name", None)
                    profile = profile_getter() if callable(profile_getter) else "default"
                attach_runtime_adapter(
                    adapter,
                    platform,
                    profile=str(profile or "default"),
                    runtime=runtime,
                )
            return connected

        @functools.wraps(original_run_agent)
        async def managed_run_agent(runner, *args, **kwargs):
            try:
                result = await original_run_agent(runner, *args, **kwargs)
            except BaseException:
                _mark_run_failed(runner, args, kwargs)
                raise
            if isinstance(result, Mapping) and bool(result.get("failed")):
                _mark_run_failed(runner, args, kwargs)
            runtime = runtime_provider() or getattr(runner, "_agent_butler_runtime", None)
            if runtime is not None:
                runtime.record_coverage("runLifecycle", "ok")
            return result

        gateway_runner_class.start = managed_start
        gateway_runner_class.stop = managed_stop
        gateway_runner_class._connect_adapter_with_timeout = managed_connect
        gateway_runner_class._run_agent_inner = managed_run_agent
        gateway_runner_class._agent_butler_gateway_hooks_v1 = True

    if getattr(turn_runner_class, "_agent_butler_progress_hooks_v1", False):
        return
    original_progress = turn_runner_class.progress_callback

    @functools.wraps(original_progress)
    def managed_progress(turn_runner, event_type, tool_name=None, preview=None, args=None, **kwargs):
        runner = getattr(turn_runner, "_runner", None)
        turn_context = getattr(turn_runner, "_ctx", None)
        session_key = getattr(turn_context, "session_key", None)
        lifecycle = _lookup_active_run(runner, session_key)
        runtime = runtime_provider() or getattr(runner, "_agent_butler_runtime", None)
        if lifecycle is not None and runtime is not None and runtime.outbox is not None:
            event_key = _next_progress_key(lifecycle)
            summary = _progress_summary(event_type, tool_name, preview, kwargs)
            try:
                runtime.outbox.append_task_event(
                    lifecycle.run_id,
                    "progress",
                    summary=summary,
                    event_key=event_key,
                )
                runtime.record_coverage("progress", "ok")
            except (KeyError, ValueError):
                # A callback racing the terminal boundary is stale, not a new
                # task failure. The durable lifecycle remains authoritative.
                pass
        return original_progress(
            turn_runner,
            event_type,
            tool_name=tool_name,
            preview=preview,
            args=args,
            **kwargs,
        )

    turn_runner_class.progress_callback = managed_progress
    turn_runner_class._agent_butler_progress_hooks_v1 = True


def install_api_server_hooks(
    api_server_class: type,
    *,
    runtime_provider=get_process_runtime,
) -> None:
    """Capture one assembled API result at the common ``_run_agent`` boundary."""

    if getattr(api_server_class, "_agent_butler_api_hooks_v1", False):
        return
    original_run_agent = api_server_class._run_agent
    signature = inspect.signature(original_run_agent)

    @functools.wraps(original_run_agent)
    async def managed_api_run(adapter, *args, **kwargs):
        runtime, binding = _require_runtime_binding(adapter, runtime_provider)
        bound = signature.bind_partial(adapter, *args, **kwargs)
        user_message = str(bound.arguments.get("user_message") or "")
        session_id = _first_string(
            bound.arguments.get("gateway_session_key"),
            bound.arguments.get("session_id"),
            bound.arguments.get("active_run_id"),
            f"api:{uuid7()}",
        )
        chat_id = _first_string(bound.arguments.get("session_id"), session_id)
        inbound_id = uuid7()
        runtime.outbox.record_inbound(
            {
                "inboundMessageId": inbound_id,
                "instanceId": runtime.config.instance_id,
                "adapterId": binding.adapter_id,
                "channel": binding.channel,
                "accountId": binding.account_id,
                "chatId": chat_id,
                "threadId": None,
                "userId": None,
                "sessionId": session_id,
                "runId": None,
                "content": user_message,
                "receivedAt": _utc_now(),
                "source": "api-server",
            }
        )
        started = runtime.outbox.begin_run(
            session_id=session_id,
            inbound_message_id=inbound_id,
        )
        run_id = started["run"]["runId"]
        is_stream = callable(bound.arguments.get("stream_delta_callback"))

        with run_lifecycle_scope(run_id) as lifecycle:
            progress_callback = bound.arguments.get("tool_progress_callback")
            bound.arguments["tool_progress_callback"] = _api_progress_callback(
                runtime,
                lifecycle,
                progress_callback,
            )
            try:
                with message_context(
                    **_binding_context(
                        runtime,
                        binding,
                        chat_id=chat_id,
                        session_id=session_id,
                        run_id=run_id,
                        inbound_message_id=inbound_id,
                        transport="inline-response",
                    )
                ):
                    result = await original_run_agent(*bound.args, **bound.kwargs)
                    result_payload = result[0] if isinstance(result, tuple) and result else result
                    final_response = (
                        result_payload.get("final_response")
                        if isinstance(result_payload, Mapping)
                        else None
                    )
                    if isinstance(result_payload, Mapping) and bool(result_payload.get("failed")):
                        lifecycle.failed = True
                    if final_response is not None and str(final_response):
                        capture_inline_response(
                            binding,
                            runtime.registry,
                            chat_id=chat_id,
                            content=str(final_response),
                            metadata={
                                "notify": True,
                                "apiSurface": "sse" if is_stream else "json",
                            },
                        )
                runtime.record_coverage("apiSse" if is_stream else "apiJson", "ok")
                runtime.record_coverage("apiServerFinalizer", "ok")
                return result
            except BaseException:
                lifecycle.failed = True
                raise
            finally:
                runtime.outbox.finish_run(run_id, failed=lifecycle.failed)

    api_server_class._run_agent = managed_api_run
    api_server_class._agent_butler_api_hooks_v1 = True


def install_a2a_hooks(a2a_class: type) -> None:
    """Route callback creation through Outbox and install reliable delivery."""

    if getattr(a2a_class, "_agent_butler_a2a_hooks_v1", False):
        return
    original_push = a2a_class._send_push_notification
    module_globals = getattr(original_push, "__globals__", {})

    def managed_push_notification(adapter, task_id, context_id, reply, state):
        config = adapter.tasks.get_push_config(str(task_id))
        if not isinstance(config, Mapping):
            return None
        send = getattr(adapter, "send", None)
        if not callable(send):
            raise RuntimeError("A2A adapter send hook is unavailable")
        coroutine = send(
            str(context_id),
            str(reply or ""),
            reply_to=str(task_id),
            metadata={
                "notify": True,
                "a2a_state": str(state or "completed"),
                "butler_proactive": True,
            },
        )
        if not inspect.isawaitable(coroutine):
            raise RuntimeError("A2A adapter send hook did not return an awaitable")
        adapter_loop = getattr(adapter, "_loop", None)
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = None
        try:
            if adapter_loop is not None and adapter_loop.is_running():
                if current_loop is adapter_loop:
                    task = adapter_loop.create_task(coroutine)
                    task.add_done_callback(_consume_scheduled_a2a_capture)
                else:
                    future = asyncio.run_coroutine_threadsafe(coroutine, adapter_loop)
                    result = future.result(timeout=10)
                    _require_capture_success(result)
            elif current_loop is not None:
                task = current_loop.create_task(coroutine)
                task.add_done_callback(_consume_scheduled_a2a_capture)
            else:
                _require_capture_success(asyncio.run(coroutine))
        except BaseException:
            close = getattr(coroutine, "close", None)
            if callable(close):
                close()
            raise
        return None

    async def butler_deliver_push(adapter, task_id, context_id, content, metadata):
        protocol = module_globals.get("protocol")
        security = module_globals.get("security")
        urllib_request = module_globals.get("urllib").request if module_globals.get("urllib") else None
        json_module = module_globals.get("json")
        logger = module_globals.get("logger")
        if protocol is None or security is None or urllib_request is None or json_module is None:
            return HookSendResult(False, error="A2A push runtime dependencies are unavailable")

        config = adapter.tasks.get_push_config(str(task_id))
        callback_url = (
            config.get("pushNotificationConfig", {}).get("url")
            if isinstance(config, Mapping)
            else None
        )
        if not isinstance(callback_url, str) or not callback_url:
            return HookSendResult(False, error="A2A push callback is unavailable")
        if not security.is_safe_callback_url(callback_url):
            protocol.metrics.push_failed += 1
            return HookSendResult(False, error="A2A push callback URL is unsafe")

        state = "completed"
        if isinstance(metadata, Mapping):
            requested_state = metadata.get("a2a_state")
            if isinstance(requested_state, str) and requested_state:
                state = requested_state
        payload = protocol.status_update(
            str(task_id),
            str(context_id),
            state,
            str(content or "")[:2000],
        )
        signature_value = security.sign_push_payload(payload)
        headers = {"Content-Type": "application/json"}
        if signature_value:
            headers["X-A2A-Signature"] = signature_value

        def _post() -> int:
            data = json_module.dumps(payload).encode("utf-8")
            request = urllib_request.Request(
                callback_url,
                data=data,
                headers=headers,
                method="POST",
            )
            with urllib_request.urlopen(request, timeout=10) as response:
                return int(response.status)

        try:
            status = await asyncio.to_thread(_post)
        except Exception as exc:
            protocol.metrics.push_failed += 1
            if logger is not None:
                logger.warning("A2A: Butler push for task %s failed: %s", task_id, exc)
            return HookSendResult(False, error=str(exc))
        if not 200 <= status < 300:
            protocol.metrics.push_failed += 1
            return HookSendResult(False, error=f"A2A push returned HTTP {status}")

        config_id = config.get("configId") if isinstance(config, Mapping) else ""
        adapter.tasks.delete_push_config(str(task_id), str(config_id or ""))
        protocol.metrics.push_sent += 1
        return HookSendResult(True, message_id=f"a2a-push:{task_id}")

    a2a_class.butler_deliver_push = butler_deliver_push
    a2a_class._send_push_notification = managed_push_notification
    a2a_class._agent_butler_a2a_hooks_v1 = True


def _require_runtime_binding(adapter: Any, runtime_provider) -> tuple[BridgeRuntime, AdapterBinding]:
    runtime = runtime_provider()
    if runtime is None or runtime.outbox is None or runtime.registry is None:
        raise RuntimeError("Agent Butler Bridge runtime is not started")
    binding = runtime.registry.binding_for(adapter)
    if binding is None:
        raise RuntimeError("Hermes adapter reached a Butler hook before attach")
    return runtime, binding


def _consume_scheduled_a2a_capture(task: asyncio.Future) -> None:
    try:
        _require_capture_success(task.result())
    except Exception:
        # The scheduled capture already reports through the gateway task/log
        # machinery. Consuming the exception prevents an unhandled-task leak.
        pass


def _require_capture_success(result: Any) -> None:
    if not bool(getattr(result, "success", False)):
        raise RuntimeError(str(getattr(result, "error", None) or "A2A push capture failed"))


def _binding_context(
    runtime: BridgeRuntime,
    binding: AdapterBinding,
    *,
    chat_id: Any = None,
    thread_id: Any = None,
    session_id: Any = None,
    run_id: Any = None,
    inbound_message_id: Any = None,
    transport: Any = None,
) -> dict[str, str | None]:
    return {
        "instance_id": runtime.config.instance_id,
        "adapter_id": binding.adapter_id,
        "channel": binding.channel,
        "account_id": binding.account_id,
        "chat_id": _optional_string(chat_id),
        "thread_id": _optional_string(thread_id),
        "session_id": _optional_string(session_id),
        "run_id": _optional_string(run_id),
        "inbound_message_id": _optional_string(inbound_message_id),
        "transport": _optional_string(transport),
    }


async def _capture_task_receipt(
    adapter: Any,
    binding: AdapterBinding,
    runtime: BridgeRuntime,
    source: Any,
    run_id: str,
) -> None:
    """Capture one durable acknowledgement without allowing a native send."""

    if binding.channel != "weixin" or runtime.outbox.has_task_receipt(run_id):
        return
    chat_id = getattr(source, "chat_id", None)
    if chat_id is None:
        return
    try:
        result = await adapter.send(
            chat_id,
            "已收到，任务完成后汇报。",
            metadata={
                "notify": True,
                "solicitedReply": True,
                "butler_message_kind": "system",
                "butler_priority": "normal",
                "butler_task_receipt": True,
            },
        )
        if not bool(getattr(result, "success", False)):
            runtime.record_coverage("taskReceipt", "degraded")
        else:
            runtime.record_coverage("taskReceipt", "ok")
    except Exception:
        # A receipt is best-effort; task execution and final reporting continue.
        runtime.record_coverage("taskReceipt", "degraded")


async def _finalize_task_result(
    runtime: BridgeRuntime,
    binding: AdapterBinding,
    run_id: str,
    *,
    failed: bool,
) -> None:
    """Generate and persist the Weixin summary before publishing the terminal event."""

    outbox = runtime.outbox
    try:
        outbox.append_task_event(run_id, "completing", event_key="lifecycle:completing")
    except (KeyError, ValueError):
        # Idempotent replay or a terminal run; continue to inspect pending results.
        pass
    if binding.channel != "weixin":
        return
    pending = await _wait_for_stable_run_results(outbox, run_id)
    if not pending:
        return
    # The last assembled terminal result is the most complete one in Hermes'
    # normal streaming path. Older terminal records stay in the audit trail but
    # must never win canonical selection over a later capture.
    canonical = max(pending, key=lambda item: (int(item.get("sequence", 0)), str(item.get("messageId", ""))))
    task = outbox.task_view(run_id) or {}
    events = task.get("events", []) if isinstance(task, Mapping) else []
    event_summaries = [
        str(event.get("summary"))
        for event in events
        if isinstance(event, Mapping) and isinstance(event.get("summary"), str) and event.get("summary")
    ]
    result = await summarize_task_with_llm(
        str(canonical.get("content") or ""),
        event_summaries,
        failed=failed,
        config=runtime.config.llm,
    )
    updates: dict[str, Any] = {
        "summaryStatus": result.get("status", "fallback"),
        "summaryGeneratedAt": _utc_now(),
        "taskCanonical": True,
    }
    if result.get("status") == "success":
        updates["summaryModel"] = runtime.config.llm.model if runtime.config.llm is not None else ""
        outbox.finalize_pending_message(
            str(canonical["messageId"]),
            content=result["summary"],
            metadata_updates=updates,
        )
        runtime.record_coverage("taskSummary", "ok")
    else:
        updates["summaryError"] = result.get("reason", "llm-request-failed")
        outbox.finalize_pending_message(str(canonical["messageId"]), metadata_updates=updates)
        runtime.record_coverage("taskSummary", "degraded")
    for duplicate in pending:
        if duplicate.get("messageId") == canonical.get("messageId"):
            continue
        try:
            outbox.absorb_message(str(duplicate["messageId"]))
        except (KeyError, ValueError):
            # A concurrent/replayed finalization may already have absorbed it.
            continue


async def _wait_for_stable_run_results(outbox: Any, run_id: str) -> list[dict[str, Any]]:
    """Wait briefly for late terminal captures, then return a stable snapshot."""

    loop = asyncio.get_running_loop()
    deadline = loop.time() + TASK_RESULT_SETTLE_TIMEOUT_SECONDS
    previous_signature: tuple[tuple[str, int, str], ...] | None = None
    stable_since: float | None = None
    latest: list[dict[str, Any]] = []
    while True:
        latest = outbox.pending_run_results(run_id)
        signature = tuple(
            (
                str(item.get("messageId", "")),
                int(item.get("sequence", 0)),
                str(item.get("contentSha256", "")),
            )
            for item in latest
        )
        now = loop.time()
        if latest and signature == previous_signature:
            if stable_since is None:
                stable_since = now
            if now - stable_since >= TASK_RESULT_SETTLE_DELAY_SECONDS:
                return latest
        else:
            previous_signature = signature
            stable_since = now if latest else None
        if now >= deadline:
            return latest
        await asyncio.sleep(0.01)


async def _record_inbound(
    runtime: BridgeRuntime,
    binding: AdapterBinding,
    event: Any,
    *,
    wait_for_decision: bool = False,
) -> tuple[str, bool]:
    source = getattr(event, "source", None)
    raw_message_id = _optional_string(getattr(event, "message_id", None))
    inbound_id = _event_inbound_id(event)
    if inbound_id is None:
        inbound_id = (
            f"{binding.adapter_id}:{raw_message_id}"
            if raw_message_id is not None
            else uuid7()
        )
        try:
            setattr(event, "_agent_butler_inbound_message_id", inbound_id)
        except Exception:
            pass
    platform = getattr(source, "platform", binding.channel)
    platform_value = getattr(platform, "value", platform)
    metadata = getattr(event, "metadata", None)
    session_id = (
        _optional_string(metadata.get("gateway_session_key"))
        if isinstance(metadata, Mapping)
        else None
    )
    message_type = getattr(event, "message_type", None)
    message_type_value = getattr(message_type, "value", message_type)
    envelope = {
        "inboundMessageId": inbound_id,
        "instanceId": runtime.config.instance_id,
        "adapterId": binding.adapter_id,
        "channel": binding.channel,
        "accountId": binding.account_id,
        "chatId": _first_string(getattr(source, "chat_id", None), "unknown"),
        "threadId": _optional_string(getattr(source, "thread_id", None)),
        "userId": _first_string(
            getattr(event, "user_id", None),
            getattr(source, "user_id", None),
        ),
        "sessionId": session_id,
        "runId": None,
        "content": str(getattr(event, "text", "") or ""),
        "receivedAt": _event_received_at(event),
        "source": str(platform_value or binding.channel),
        "platformMessageId": raw_message_id,
        "messageType": None if message_type_value is None else str(message_type_value),
        "attachmentCount": len(getattr(event, "media_urls", None) or ()),
    }
    existing = runtime.outbox.get_inbound(inbound_id)
    if existing is not None:
        stable_keys = (
            "instanceId",
            "adapterId",
            "channel",
            "accountId",
            "chatId",
            "threadId",
            "userId",
            "content",
            "source",
            "platformMessageId",
            "messageType",
            "attachmentCount",
        )
        if all(existing.get(key) == envelope.get(key) for key in stable_keys):
            if runtime.outbox.get_inbound_decision(inbound_id) is None:
                runtime.schedule_inbound_optimization(inbound_id, str(envelope["content"]))
            if wait_for_decision and relay_mode(runtime.outbox) != RELAY_PASSTHROUGH:
                await runtime.wait_inbound_optimization(inbound_id)
            return inbound_id, True
    recorded = runtime.outbox.record_inbound(envelope)
    if not bool(recorded["deduped"]):
        runtime.schedule_inbound_optimization(inbound_id, str(envelope["content"]))
    if wait_for_decision and relay_mode(runtime.outbox) != RELAY_PASSTHROUGH:
        await runtime.wait_inbound_optimization(inbound_id)
    return inbound_id, bool(recorded["deduped"])


async def _ensure_inbound_decision(
    runtime: BridgeRuntime, inbound_id: str, content: str
) -> None:
    """为新入站消息生成优化决策；任何异常都静默降级，绝不阻塞消息。"""
    try:
        if not getattr(runtime.config, "inbound_optimize", True):
            return
        if runtime.outbox is None:
            return
        if runtime.outbox.get_inbound_decision(inbound_id) is not None:
            return
        result = optimize_inbound(content)
        runtime.outbox.apply_inbound_decision(
            inbound_id,
            {
                "inboundMessageId": inbound_id,
                "action": "forward",
                "optimizedText": result["optimizedText"],
                "transformTrace": result["transformTrace"],
                "changes": result["changes"],
                "mode": result["mode"],
            },
        )
        if result["mode"] == "pass-through":
            llm_result = await optimize_with_llm(
                content,
                getattr(runtime.config, "llm", None),
            )
            if llm_result is not None:
                runtime.outbox.apply_inbound_decision(
                    inbound_id,
                    {
                        "inboundMessageId": inbound_id,
                        "action": "forward",
                        **llm_result,
                    },
                )
    except Exception:
        return


def _apply_inbound_optimization(runtime: BridgeRuntime, inbound_id: str, event: Any) -> Any:
    """把已落库的优化文本应用到 Hermes 事件；失败时原样返回，绝不丢消息。"""
    try:
        if runtime.outbox is None:
            return event
        decision = runtime.outbox.get_inbound_decision(inbound_id)
        if decision is None or decision.get("action") != "forward":
            return event
        optimized = decision.get("optimizedText")
        original = str(getattr(event, "text", "") or "")
        if not isinstance(optimized, str) or not optimized or optimized == original:
            return event
        clone = copy.copy(event)
        setattr(clone, "text", optimized)
        if hasattr(event, "content"):
            setattr(clone, "content", optimized)
        return clone
    except Exception:
        return event


def _event_inbound_id(event: Any) -> str | None:
    return _optional_string(getattr(event, "_agent_butler_inbound_message_id", None))


def _event_received_at(event: Any) -> str:
    existing = _optional_string(getattr(event, "_agent_butler_received_at", None))
    if existing is not None:
        return existing
    timestamp = getattr(event, "timestamp", None)
    if isinstance(timestamp, datetime):
        if timestamp.tzinfo is None:
            timestamp = timestamp.astimezone()
        selected = timestamp.astimezone(timezone.utc).isoformat(timespec="milliseconds")
        selected = selected.replace("+00:00", "Z")
    else:
        selected = _utc_now()
    try:
        setattr(event, "_agent_butler_received_at", selected)
    except Exception:
        pass
    return selected


def _active_run_map(runner: Any, *, create: bool) -> dict[str, RunLifecycleState] | None:
    if runner is None:
        return None
    active = getattr(runner, "_agent_butler_active_runs", None)
    if active is None and create:
        active = {}
        runner._agent_butler_active_runs = active
    return active if isinstance(active, dict) else None


def _lookup_active_run(runner: Any, session_key: Any) -> RunLifecycleState | None:
    active = _active_run_map(runner, create=False)
    if active is None or session_key is None:
        return None
    candidate = active.get(str(session_key))
    return candidate if isinstance(candidate, RunLifecycleState) else None


def _next_progress_key(lifecycle: RunLifecycleState) -> str:
    with lifecycle.lock:
        lifecycle.progress_sequence += 1
        return f"progress:{lifecycle.progress_sequence}"


def _progress_summary(
    event_type: Any,
    tool_name: Any,
    preview: Any,
    kwargs: Mapping[str, Any],
) -> str:
    parts = [str(event_type or "progress")]
    if tool_name:
        parts.append(str(tool_name))
    if preview:
        parts.append(str(preview).replace("\n", " ")[:300])
    duration = kwargs.get("duration")
    if isinstance(duration, (int, float)) and duration >= 0:
        parts.append(f"{duration:.2f}s")
    return " · ".join(parts)[:1000]


def _mark_run_failed(runner: Any, args: tuple[Any, ...], kwargs: Mapping[str, Any]) -> None:
    mark_current_run_failed()
    session_key = kwargs.get("session_key")
    if session_key is None and len(args) > 5:
        session_key = args[5]
    lifecycle = _lookup_active_run(runner, session_key)
    if lifecycle is not None:
        with lifecycle.lock:
            lifecycle.failed = True


def _api_progress_callback(
    runtime: BridgeRuntime,
    lifecycle: RunLifecycleState,
    original: Any,
):
    def callback(event_type, tool_name=None, preview=None, args=None, **kwargs):
        event_key = _next_progress_key(lifecycle)
        try:
            runtime.outbox.append_task_event(
                lifecycle.run_id,
                "progress",
                summary=_progress_summary(event_type, tool_name, preview, kwargs),
                event_key=event_key,
            )
            runtime.record_coverage("progress", "ok")
        except (KeyError, ValueError):
            pass
        if callable(original):
            return original(
                event_type,
                tool_name=tool_name,
                preview=preview,
                args=args,
                **kwargs,
            )
        return None

    return callback


def _optional_string(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _first_string(*values: Any) -> str:
    for value in values:
        selected = _optional_string(value)
        if selected is not None:
            return selected
    raise ValueError("at least one non-empty string is required")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def attach_runtime_adapter(
    adapter: Any,
    platform: Any,
    *,
    profile: str = "default",
    runtime: BridgeRuntime | None = None,
) -> AdapterBinding:
    selected_runtime = runtime or get_process_runtime()
    if selected_runtime is None or selected_runtime.registry is None:
        raise RuntimeError("Agent Butler Bridge runtime is not started")
    channel = normalize_channel(platform)
    account_id = _adapter_account_id(adapter)
    adapter_id = ":".join(
        (
            _safe_segment(channel),
            _safe_segment(profile or "default"),
            _safe_segment(account_id or "default"),
        )
    )

    if channel == "api-server":
        binding = selected_runtime.registry.attach(
            adapter,
            adapter_id=adapter_id,
            channel=channel,
            account_id=account_id,
            default_transport="inline-response",
        )
        selected_runtime.record_coverage(f"adapter:{adapter_id}", "ok")
        selected_runtime.record_coverage("apiServerFinalizer", "pending")
        return binding

    if channel == "a2a":
        push_hook = getattr(adapter, "butler_deliver_push", None)
        binding = attach_adapter(
            adapter,
            selected_runtime.registry,
            adapter_id=adapter_id,
            channel=channel,
            account_id=account_id,
            default_transport="queued-push",
            transport_resolver=lambda chat_id, _content, _reply_to, _metadata: (
                "inline-response" if a2a_has_waiter(adapter, chat_id) else "queued-push"
            ),
            capture_filter=lambda _chat_id, _content, _reply_to, metadata: bool(
                metadata.get("notify")
            ),
            delivery_override=lambda row: _deliver_a2a_push(adapter, row),
            wrap_media=False,
        )
        selected_runtime.record_coverage(f"adapter:{adapter_id}", "ok")
        selected_runtime.record_coverage("a2aWaiter", "ok")
        selected_runtime.record_coverage(
            "a2aPush", "ok" if callable(push_hook) else "degraded"
        )
        selected_runtime.record_coverage(
            f"queuedSend:{adapter_id}", "ok" if callable(push_hook) else "degraded"
        )
        return binding

    binding = attach_adapter(
        adapter,
        selected_runtime.registry,
        adapter_id=adapter_id,
        channel=channel,
        account_id=account_id,
        default_transport="queued-push",
        wrap_media=True,
    )
    selected_runtime.record_coverage(f"adapter:{adapter_id}", "ok")
    selected_runtime.record_coverage(f"queuedSend:{adapter_id}", "ok")
    selected_runtime.record_coverage(
        f"edit:{adapter_id}", "ok" if binding.original_edit is not None else "degraded"
    )
    media_status = "ok" if binding.original_media else "pending"
    selected_runtime.record_coverage(
        f"mediaDirect:{adapter_id}", media_status
    )
    return binding


def normalize_channel(platform: Any) -> str:
    value = getattr(platform, "value", platform)
    if not isinstance(value, str) or not value.strip():
        raise ValueError("platform must identify a non-empty channel")
    normalized = value.strip().casefold()
    return CHANNEL_ALIASES.get(normalized, normalized.replace("_", "-"))


def a2a_has_waiter(adapter: Any, context_id: str) -> bool:
    pending = getattr(adapter, "_pending", None)
    order = getattr(adapter, "_pending_order", None)
    lock = getattr(adapter, "_pending_lock", None)
    if not isinstance(pending, dict) or not isinstance(order, dict):
        return False

    def inspect_waiters() -> bool:
        for task_id in order.get(context_id, ()):
            entry = pending.get(task_id)
            if not isinstance(entry, tuple) or len(entry) < 2:
                continue
            future = entry[1]
            done = getattr(future, "done", None)
            if callable(done) and not done():
                return True
        return False

    if hasattr(lock, "__enter__") and hasattr(lock, "__exit__"):
        with lock:
            return inspect_waiters()
    return inspect_waiters()


async def _deliver_a2a_push(adapter: Any, row: dict[str, Any]) -> Any:
    hook = getattr(adapter, "butler_deliver_push", None)
    if not callable(hook):
        return HookSendResult(
            success=False,
            error="A2A proactive push hook is unavailable",
        )
    task_id = row.get("replyTo")
    if not isinstance(task_id, str) or not task_id:
        return HookSendResult(
            success=False,
            error="A2A proactive push requires the source task id",
        )
    result = hook(task_id, row["chatId"], row["content"], row["metadata"])
    return await result if inspect.isawaitable(result) else result


def _adapter_account_id(adapter: Any) -> str | None:
    for attribute in ("_account_id", "account_id"):
        value = getattr(adapter, attribute, None)
        if isinstance(value, str) and value.strip():
            return value.strip()
    config = getattr(adapter, "config", None)
    extra = getattr(config, "extra", None)
    if isinstance(extra, Mapping):
        for key in ("account_id", "account", "bot_id"):
            value = extra.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def _safe_segment(value: str) -> str:
    cleaned = "".join(
        character if character.isalnum() or character in {"-", "_", "."} else "-"
        for character in value.strip()
    ).strip("-")
    return cleaned[:96] or "default"
