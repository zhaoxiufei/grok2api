"""
linux.do OAuth2 login integration.

OAuth tokens are stored in memory and treated as valid public credentials.
"""

import asyncio
import time
import uuid

import aiohttp
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import RedirectResponse

from app.core.config import get_config
from app.core.auth import is_public_enabled
from app.core.logger import logger

router = APIRouter(prefix="/oauth")

# OAuth token store: {token_str: {"user": {...}, "created_at": float}}
_oauth_tokens: dict[str, dict] = {}
_oauth_lock = asyncio.Lock()

OAUTH_TOKEN_TTL = 86400  # 24h
STATE_TTL = 300  # 5min
_pending_states: dict[str, float] = {}

LINUXDO_AUTHORIZE_URL = "https://connect.linux.do/oauth2/authorize"
LINUXDO_TOKEN_URL = "https://connect.linux.do/oauth2/token"
LINUXDO_USER_URL = "https://connect.linux.do/api/user"


def _is_linuxdo_enabled() -> bool:
    return bool(get_config("oauth.linuxdo_enabled", False))


def _get_redirect_uri() -> str:
    app_url = (get_config("app.app_url", "") or "").rstrip("/")
    return f"{app_url}/v1/public/oauth/linuxdo/callback"


async def _clean_expired() -> None:
    now = time.time()
    expired = [k for k, v in _oauth_tokens.items() if now - v["created_at"] > OAUTH_TOKEN_TTL]
    for k in expired:
        _oauth_tokens.pop(k, None)
    expired_states = [k for k, t in _pending_states.items() if now - t > STATE_TTL]
    for k in expired_states:
        _pending_states.pop(k, None)


def verify_oauth_token(token: str) -> bool:
    """Check if a token is a valid OAuth session token."""
    if not token:
        return False
    info = _oauth_tokens.get(token)
    if not info:
        return False
    if time.time() - info["created_at"] > OAUTH_TOKEN_TTL:
        _oauth_tokens.pop(token, None)
        return False
    return True


def get_oauth_user_id(token: str) -> str | None:
    """Extract user_id (username) from an OAuth session token. Returns None for non-OAuth tokens."""
    if not token:
        return None
    info = _oauth_tokens.get(token)
    if not info:
        return None
    if time.time() - info["created_at"] > OAUTH_TOKEN_TTL:
        _oauth_tokens.pop(token, None)
        return None
    user = info.get("user") or {}
    return user.get("username") or user.get("name") or None


@router.get("/config")
async def oauth_config():
    """Return OAuth provider availability (no auth required)."""
    return {"linuxdo_enabled": _is_linuxdo_enabled() and is_public_enabled()}


@router.get("/linuxdo/login")
async def linuxdo_login():
    """Redirect user to linux.do authorization page."""
    if not _is_linuxdo_enabled() or not is_public_enabled():
        raise HTTPException(status_code=404, detail="OAuth login is not enabled")

    client_id = get_config("oauth.linuxdo_client_id", "")
    if not client_id:
        raise HTTPException(status_code=500, detail="OAuth client_id is not configured")

    state = uuid.uuid4().hex
    async with _oauth_lock:
        await _clean_expired()
        _pending_states[state] = time.time()

    redirect_uri = _get_redirect_uri()
    url = (
        f"{LINUXDO_AUTHORIZE_URL}"
        f"?response_type=code"
        f"&client_id={client_id}"
        f"&redirect_uri={redirect_uri}"
        f"&state={state}"
    )
    return RedirectResponse(url=url, status_code=302)


@router.get("/linuxdo/callback")
async def linuxdo_callback(code: str = Query(""), state: str = Query("")):
    """Handle OAuth callback: exchange code for token, create session."""
    if not _is_linuxdo_enabled() or not is_public_enabled():
        raise HTTPException(status_code=404, detail="OAuth login is not enabled")

    # Validate state (CSRF protection)
    async with _oauth_lock:
        await _clean_expired()
        created = _pending_states.pop(state, None)

    if not created or not state:
        raise HTTPException(status_code=400, detail="Invalid or expired state parameter")

    if not code:
        raise HTTPException(status_code=400, detail="Missing authorization code")

    client_id = get_config("oauth.linuxdo_client_id", "")
    client_secret = get_config("oauth.linuxdo_client_secret", "")
    redirect_uri = _get_redirect_uri()

    # Exchange code for access_token
    proxy = get_config("proxy.base_proxy_url", "") or None
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                LINUXDO_TOKEN_URL,
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": redirect_uri,
                    "client_id": client_id,
                    "client_secret": client_secret,
                },
                headers={"Accept": "application/json"},
                timeout=aiohttp.ClientTimeout(total=15),
                proxy=proxy,
            ) as resp:
                if resp.status != 200:
                    body = await resp.text()
                    logger.warning(f"OAuth token exchange failed: {resp.status} {body}")
                    raise HTTPException(status_code=502, detail="Failed to exchange authorization code")
                token_data = await resp.json()

            access_token = token_data.get("access_token")
            if not access_token:
                raise HTTPException(status_code=502, detail="No access_token in response")

            # Fetch user info
            async with session.get(
                LINUXDO_USER_URL,
                headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
                timeout=aiohttp.ClientTimeout(total=15),
                proxy=proxy,
            ) as resp:
                if resp.status != 200:
                    raise HTTPException(status_code=502, detail="Failed to fetch user info")
                user_info = await resp.json()

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"OAuth callback error: {e}")
        raise HTTPException(status_code=502, detail="OAuth provider communication error")

    # Create session token
    session_token = uuid.uuid4().hex
    async with _oauth_lock:
        await _clean_expired()
        _oauth_tokens[session_token] = {
            "user": user_info,
            "created_at": time.time(),
        }

    username = user_info.get("username", user_info.get("name", "unknown"))
    logger.info(f"OAuth login success: {username}")

    # Initialize credits account for this user
    try:
        from app.services.credits.manager import get_credits_manager
        credits_mgr = await get_credits_manager()
        await credits_mgr.ensure_user(username)
    except Exception as e:
        logger.warning(f"OAuth credits init failed for {username}: {e}")

    # Redirect to login page with token
    app_url = (get_config("app.app_url", "") or "").rstrip("/")
    return RedirectResponse(url=f"{app_url}/login?oauth_token={session_token}", status_code=302)


@router.get("/credits")
async def oauth_credits(auth: str = Query("", alias="token")):
    """Query current user's credits balance. Requires OAuth Bearer token."""
    token = auth
    if not token:
        raise HTTPException(status_code=401, detail="Missing token")
    user_id = get_oauth_user_id(token)
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid or expired OAuth token")

    from app.services.credits.manager import get_credits_manager
    mgr = await get_credits_manager()
    u = await mgr.get_credits(user_id)
    if not u:
        u = await mgr.ensure_user(user_id)

    from app.core.config import get_config as _gc
    return {
        "user_id": u.user_id,
        "credits": u.credits,
        "total_earned": u.total_earned,
        "total_spent": u.total_spent,
        "last_checkin": u.last_checkin,
        "credits_enabled": bool(_gc("credits.enabled", True)),
        "daily_checkin_credits": int(_gc("credits.daily_checkin_credits", 10)),
        "image_cost": int(_gc("credits.image_cost", 10)),
        "video_cost": int(_gc("credits.video_cost", 20)),
    }


@router.post("/checkin")
async def oauth_checkin(auth: str = Query("", alias="token")):
    """Daily check-in to earn credits. Requires OAuth Bearer token."""
    token = auth
    if not token:
        raise HTTPException(status_code=401, detail="Missing token")
    user_id = get_oauth_user_id(token)
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid or expired OAuth token")

    from app.services.credits.manager import get_credits_manager
    mgr = await get_credits_manager()

    # Ensure user exists
    await mgr.ensure_user(user_id)

    success, balance = await mgr.checkin(user_id)
    if not success:
        return {"success": False, "message": "Already checked in today", "credits": balance}
    return {"success": True, "message": "Check-in successful", "credits": balance}
