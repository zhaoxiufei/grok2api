import asyncio
import base64
import time
import uuid
from pathlib import Path
from typing import Optional, List, Dict

import orjson
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from app.core.auth import verify_public_key, is_valid_public_credential
from app.core.config import get_config
from app.core.logger import logger
from app.api.v1.image import resolve_aspect_ratio
from app.services.grok.services.image import ImageGenerationService
from app.services.grok.services.image_edit import ImageEditService
from app.services.grok.services.model import ModelService
from app.services.token.manager import get_token_manager

router = APIRouter()

IMAGINE_SESSION_TTL = 600
_IMAGINE_SESSIONS: dict[str, dict] = {}
_IMAGINE_SESSIONS_LOCK = asyncio.Lock()


async def _clean_sessions(now: float) -> None:
    expired = [
        key
        for key, info in _IMAGINE_SESSIONS.items()
        if now - float(info.get("created_at") or 0) > IMAGINE_SESSION_TTL
    ]
    for key in expired:
        _IMAGINE_SESSIONS.pop(key, None)


async def _new_session(prompt: str, aspect_ratio: str, nsfw: Optional[bool], user_id: Optional[str] = None) -> str:
    task_id = uuid.uuid4().hex
    now = time.time()
    async with _IMAGINE_SESSIONS_LOCK:
        await _clean_sessions(now)
        _IMAGINE_SESSIONS[task_id] = {
            "prompt": prompt,
            "aspect_ratio": aspect_ratio,
            "nsfw": nsfw,
            "user_id": user_id,
            "created_at": now,
        }
    return task_id


async def _get_session(task_id: str) -> Optional[dict]:
    if not task_id:
        return None
    now = time.time()
    async with _IMAGINE_SESSIONS_LOCK:
        await _clean_sessions(now)
        info = _IMAGINE_SESSIONS.get(task_id)
        if not info:
            return None
        created_at = float(info.get("created_at") or 0)
        if now - created_at > IMAGINE_SESSION_TTL:
            _IMAGINE_SESSIONS.pop(task_id, None)
            return None
        return dict(info)


async def _drop_session(task_id: str) -> None:
    if not task_id:
        return
    async with _IMAGINE_SESSIONS_LOCK:
        _IMAGINE_SESSIONS.pop(task_id, None)


async def _drop_sessions(task_ids: List[str]) -> int:
    if not task_ids:
        return 0
    removed = 0
    async with _IMAGINE_SESSIONS_LOCK:
        for task_id in task_ids:
            if task_id and task_id in _IMAGINE_SESSIONS:
                _IMAGINE_SESSIONS.pop(task_id, None)
                removed += 1
    return removed


@router.websocket("/imagine/ws")
async def public_imagine_ws(websocket: WebSocket):
    session_id = None
    ws_user_id = None
    task_id = websocket.query_params.get("task_id")
    if task_id:
        info = await _get_session(task_id)
        if info:
            session_id = task_id
            ws_user_id = info.get("user_id")

    ok = True
    if session_id is None:
        key = websocket.query_params.get("public_key") or ""
        ok = is_valid_public_credential(key)

    if not ok:
        await websocket.close(code=1008)
        return

    await websocket.accept()
    stop_event = asyncio.Event()
    run_task: Optional[asyncio.Task] = None

    async def _send(payload: dict) -> bool:
        try:
            await websocket.send_text(orjson.dumps(payload).decode())
            return True
        except Exception:
            return False

    async def _stop_run():
        nonlocal run_task
        stop_event.set()
        if run_task and not run_task.done():
            run_task.cancel()
            try:
                await run_task
            except Exception:
                pass
        run_task = None
        stop_event.clear()

    async def _run(prompt: str, aspect_ratio: str, nsfw: Optional[bool], user_id: Optional[str] = None):
        model_id = "grok-imagine-1.0"
        model_info = ModelService.get(model_id)
        if not model_info or not model_info.is_image:
            await _send(
                {
                    "type": "error",
                    "message": "Image model is not available.",
                    "code": "model_not_supported",
                }
            )
            return

        token_mgr = await get_token_manager()
        run_id = uuid.uuid4().hex
        sequence = 0

        await _send(
            {
                "type": "status",
                "status": "running",
                "prompt": prompt,
                "aspect_ratio": aspect_ratio,
                "run_id": run_id,
            }
        )

        while not stop_event.is_set():
            try:
                await token_mgr.reload_if_stale()
                token = None
                for pool_name in ModelService.pool_candidates_for_model(
                    model_info.model_id
                ):
                    token = token_mgr.get_token(pool_name)
                    if token:
                        break

                if not token:
                    await _send(
                        {
                            "type": "error",
                            "message": "No available tokens. Please try again later.",
                            "code": "rate_limit_exceeded",
                        }
                    )
                    await asyncio.sleep(2)
                    continue

                start_at = time.time()
                result = await ImageGenerationService().generate(
                    token_mgr=token_mgr,
                    token=token,
                    model_info=model_info,
                    prompt=prompt,
                    n=6,
                    response_format="b64_json",
                    size="1024x1024",
                    aspect_ratio=aspect_ratio,
                    stream=False,
                    enable_nsfw=nsfw,
                )
                elapsed_ms = int((time.time() - start_at) * 1000)

                images = [img for img in result.data if img and img != "error"]
                if images:
                    # Per-image credits deduction for OAuth users
                    if user_id:
                        from app.services.credits.manager import get_credits_manager
                        from app.core.config import get_config as _gc
                        if _gc("credits.enabled", True):
                            cost_per = int(_gc("credits.image_cost", 10))
                            total_cost = cost_per * len(images)
                            mgr = await get_credits_manager()
                            ok = await mgr.consume(user_id, total_cost, reason="image")
                            if not ok:
                                u = await mgr.get_credits(user_id)
                                bal = u.credits if u else 0
                                await _send({
                                    "type": "error",
                                    "message": f"Insufficient credits: need {total_cost}, have {bal}",
                                    "code": "insufficient_credits",
                                })
                                break
                            u = await mgr.get_credits(user_id)
                            await _send({"type": "credits_update", "credits": u.credits if u else 0})
                    for img_b64 in images:
                        sequence += 1
                        await _send(
                            {
                                "type": "image",
                                "b64_json": img_b64,
                                "sequence": sequence,
                                "created_at": int(time.time() * 1000),
                                "elapsed_ms": elapsed_ms,
                                "aspect_ratio": aspect_ratio,
                                "run_id": run_id,
                            }
                        )
                else:
                    await _send(
                        {
                            "type": "error",
                            "message": "Image generation returned empty data.",
                            "code": "empty_image",
                        }
                    )

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"Imagine stream error: {e}")
                await _send(
                    {
                        "type": "error",
                        "message": str(e),
                        "code": "internal_error",
                    }
                )
                await asyncio.sleep(1.5)

        await _send({"type": "status", "status": "stopped", "run_id": run_id})

    try:
        while True:
            try:
                raw = await websocket.receive_text()
            except (RuntimeError, WebSocketDisconnect):
                break

            try:
                payload = orjson.loads(raw)
            except Exception:
                await _send(
                    {
                        "type": "error",
                        "message": "Invalid message format.",
                        "code": "invalid_payload",
                    }
                )
                continue

            action = payload.get("type")
            if action == "start":
                prompt = str(payload.get("prompt") or "").strip()
                if not prompt:
                    await _send(
                        {
                            "type": "error",
                            "message": "Prompt cannot be empty.",
                            "code": "invalid_prompt",
                        }
                    )
                    continue
                aspect_ratio = resolve_aspect_ratio(
                    str(payload.get("aspect_ratio") or "2:3").strip() or "2:3"
                )
                nsfw = payload.get("nsfw")
                if nsfw is not None:
                    nsfw = bool(nsfw)
                await _stop_run()
                run_task = asyncio.create_task(_run(prompt, aspect_ratio, nsfw, ws_user_id))
            elif action == "stop":
                await _stop_run()
            else:
                await _send(
                    {
                        "type": "error",
                        "message": "Unknown action.",
                        "code": "invalid_action",
                    }
                )

    except WebSocketDisconnect:
        logger.debug("WebSocket disconnected by client")
    except Exception as e:
        logger.warning(f"WebSocket error: {e}")
    finally:
        await _stop_run()

        try:
            from starlette.websockets import WebSocketState
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.close(code=1000, reason="Server closing connection")
        except Exception as e:
            logger.debug(f"WebSocket close ignored: {e}")
        if session_id:
            await _drop_session(session_id)


@router.get("/imagine/sse")
async def public_imagine_sse(
    request: Request,
    task_id: str = Query(""),
    prompt: str = Query(""),
    aspect_ratio: str = Query("2:3"),
):
    """Imagine 图片瀑布流（SSE 兜底）"""
    session = None
    if task_id:
        session = await _get_session(task_id)
        if not session:
            raise HTTPException(status_code=404, detail="Task not found")
    else:
        key = request.query_params.get("public_key") or ""
        if not is_valid_public_credential(key):
            raise HTTPException(status_code=401, detail="Invalid authentication token")

    if session:
        prompt = str(session.get("prompt") or "").strip()
        ratio = str(session.get("aspect_ratio") or "2:3").strip() or "2:3"
        nsfw = session.get("nsfw")
        sse_user_id = session.get("user_id")
    else:
        prompt = (prompt or "").strip()
        if not prompt:
            raise HTTPException(status_code=400, detail="Prompt cannot be empty")
        ratio = str(aspect_ratio or "2:3").strip() or "2:3"
        ratio = resolve_aspect_ratio(ratio)
        nsfw = request.query_params.get("nsfw")
        if nsfw is not None:
            nsfw = str(nsfw).lower() in ("1", "true", "yes", "on")
        sse_user_id = None

    async def event_stream():
        try:
            model_id = "grok-imagine-1.0"
            model_info = ModelService.get(model_id)
            if not model_info or not model_info.is_image:
                yield (
                    f"data: {orjson.dumps({'type': 'error', 'message': 'Image model is not available.', 'code': 'model_not_supported'}).decode()}\n\n"
                )
                return

            token_mgr = await get_token_manager()
            sequence = 0
            run_id = uuid.uuid4().hex

            yield (
                f"data: {orjson.dumps({'type': 'status', 'status': 'running', 'prompt': prompt, 'aspect_ratio': ratio, 'run_id': run_id}).decode()}\n\n"
            )

            while True:
                if await request.is_disconnected():
                    break
                if task_id:
                    session_alive = await _get_session(task_id)
                    if not session_alive:
                        break

                try:
                    await token_mgr.reload_if_stale()
                    token = None
                    for pool_name in ModelService.pool_candidates_for_model(
                        model_info.model_id
                    ):
                        token = token_mgr.get_token(pool_name)
                        if token:
                            break

                    if not token:
                        yield (
                            f"data: {orjson.dumps({'type': 'error', 'message': 'No available tokens. Please try again later.', 'code': 'rate_limit_exceeded'}).decode()}\n\n"
                        )
                        await asyncio.sleep(2)
                        continue

                    start_at = time.time()
                    result = await ImageGenerationService().generate(
                        token_mgr=token_mgr,
                        token=token,
                        model_info=model_info,
                        prompt=prompt,
                        n=6,
                        response_format="b64_json",
                        size="1024x1024",
                        aspect_ratio=ratio,
                        stream=False,
                        enable_nsfw=nsfw,
                    )
                    elapsed_ms = int((time.time() - start_at) * 1000)

                    images = [img for img in result.data if img and img != "error"]
                    if images:
                        # Per-image credits deduction for OAuth users
                        if sse_user_id:
                            from app.services.credits.manager import get_credits_manager
                            from app.core.config import get_config as _gc
                            if _gc("credits.enabled", True):
                                cost_per = int(_gc("credits.image_cost", 10))
                                total_cost = cost_per * len(images)
                                mgr = await get_credits_manager()
                                ok = await mgr.consume(sse_user_id, total_cost, reason="image")
                                if not ok:
                                    u = await mgr.get_credits(sse_user_id)
                                    bal = u.credits if u else 0
                                    yield (
                                        f"data: {orjson.dumps({'type': 'error', 'message': f'Insufficient credits: need {total_cost}, have {bal}', 'code': 'insufficient_credits'}).decode()}\n\n"
                                    )
                                    break
                                u = await mgr.get_credits(sse_user_id)
                                yield f"data: {orjson.dumps({'type': 'credits_update', 'credits': u.credits if u else 0}).decode()}\n\n"
                        for img_b64 in images:
                            sequence += 1
                            payload = {
                                "type": "image",
                                "b64_json": img_b64,
                                "sequence": sequence,
                                "created_at": int(time.time() * 1000),
                                "elapsed_ms": elapsed_ms,
                                "aspect_ratio": ratio,
                                "run_id": run_id,
                            }
                            yield f"data: {orjson.dumps(payload).decode()}\n\n"
                    else:
                        yield (
                            f"data: {orjson.dumps({'type': 'error', 'message': 'Image generation returned empty data.', 'code': 'empty_image'}).decode()}\n\n"
                        )
                except asyncio.CancelledError:
                    break
                except Exception as e:
                    logger.warning(f"Imagine SSE error: {e}")
                    yield (
                        f"data: {orjson.dumps({'type': 'error', 'message': str(e), 'code': 'internal_error'}).decode()}\n\n"
                    )
                    await asyncio.sleep(1.5)

            yield (
                f"data: {orjson.dumps({'type': 'status', 'status': 'stopped', 'run_id': run_id}).decode()}\n\n"
            )
        finally:
            if task_id:
                await _drop_session(task_id)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


@router.get("/imagine/config")
async def public_imagine_config():
    return {
        "final_min_bytes": int(get_config("image.final_min_bytes") or 0),
        "medium_min_bytes": int(get_config("image.medium_min_bytes") or 0),
        "nsfw": bool(get_config("image.nsfw")),
    }


class ImagineStartRequest(BaseModel):
    prompt: str
    aspect_ratio: Optional[str] = "2:3"
    nsfw: Optional[bool] = None


@router.post("/imagine/start", dependencies=[Depends(verify_public_key)])
async def public_imagine_start(request: Request, data: ImagineStartRequest):
    prompt = (data.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt cannot be empty")
    ratio = resolve_aspect_ratio(str(data.aspect_ratio or "2:3").strip() or "2:3")

    # Extract OAuth user_id for per-image credits deduction in WS/SSE
    from app.api.v1.public_api.oauth import get_oauth_user_id
    token = ""
    auth_header = request.headers.get("authorization") or ""
    if auth_header.lower().startswith("bearer "):
        token = auth_header[7:]
    user_id = get_oauth_user_id(token) if token else None

    task_id = await _new_session(prompt, ratio, data.nsfw, user_id)
    return {"task_id": task_id, "aspect_ratio": ratio}


class ImagineStopRequest(BaseModel):
    task_ids: List[str]


@router.post("/imagine/stop", dependencies=[Depends(verify_public_key)])
async def public_imagine_stop(data: ImagineStopRequest):
    removed = await _drop_sessions(data.task_ids or [])
    return {"status": "success", "removed": removed}


@router.post("/imagine/edit", dependencies=[Depends(verify_public_key)])
async def public_imagine_edit(
    request: Request,
    prompt: str = Form(...),
    image: List[UploadFile] = File(...),
    model: Optional[str] = Form("grok-imagine-1.0-edit"),
    n: int = Form(1),
    response_format: Optional[str] = Form("b64_json"),
):
    prompt = (prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt cannot be empty")

    model_id = model or "grok-imagine-1.0-edit"
    model_info = ModelService.get(model_id)
    if not model_info:
        raise HTTPException(status_code=400, detail="Model not available")

    max_image_bytes = 50 * 1024 * 1024
    allowed_types = {"image/png", "image/jpeg", "image/webp", "image/jpg"}

    images: List[str] = []
    for item in image:
        content = await item.read()
        await item.close()
        if not content:
            raise HTTPException(status_code=400, detail="File content is empty")
        if len(content) > max_image_bytes:
            raise HTTPException(status_code=400, detail="Image file too large. Maximum is 50MB.")
        mime = (item.content_type or "").lower()
        if mime == "image/jpg":
            mime = "image/jpeg"
        ext = Path(item.filename or "").suffix.lower()
        if mime not in allowed_types:
            if ext in (".jpg", ".jpeg"):
                mime = "image/jpeg"
            elif ext == ".png":
                mime = "image/png"
            elif ext == ".webp":
                mime = "image/webp"
            else:
                raise HTTPException(status_code=400, detail="Unsupported image type. Supported: png, jpg, webp.")
        b64 = base64.b64encode(content).decode()
        images.append(f"data:{mime};base64,{b64}")

    token_mgr = await get_token_manager()
    await token_mgr.reload_if_stale()
    token = None
    for pool_name in ModelService.pool_candidates_for_model(model_id):
        token = token_mgr.get_token(pool_name)
        if token:
            break
    if not token:
        raise HTTPException(status_code=503, detail="No available tokens")

    fmt = response_format or "b64_json"
    result = await ImageEditService().edit(
        token_mgr=token_mgr,
        token=token,
        model_info=model_info,
        prompt=prompt,
        images=images,
        n=n,
        response_format=fmt,
        stream=False,
    )

    output_images = [img for img in result.data if img and img != "error"]

    # Per-image credits deduction for OAuth users
    from app.api.v1.public_api.oauth import get_oauth_user_id
    auth_header = request.headers.get("authorization") or ""
    bearer_token = auth_header[7:] if auth_header.lower().startswith("bearer ") else ""
    user_id = get_oauth_user_id(bearer_token) if bearer_token else None

    credits_info = None
    if user_id and output_images:
        from app.services.credits.manager import get_credits_manager
        if get_config("credits.enabled", True):
            cost_per = int(get_config("credits.image_edit_cost", 10))
            total_cost = cost_per * len(output_images)
            mgr = await get_credits_manager()
            ok = await mgr.consume(user_id, total_cost, reason="image_edit")
            if not ok:
                u = await mgr.get_credits(user_id)
                bal = u.credits if u else 0
                credits_info = {"error": True, "message": f"Insufficient credits: need {total_cost}, have {bal}", "credits": bal}
            else:
                u = await mgr.get_credits(user_id)
                credits_info = {"credits": u.credits if u else 0}

    field = "b64_json" if fmt == "b64_json" else "url"
    data = [{field: img} for img in output_images]

    resp: dict = {
        "created": int(time.time()),
        "data": data,
    }
    if credits_info:
        resp["credits_info"] = credits_info

    return JSONResponse(content=resp)
