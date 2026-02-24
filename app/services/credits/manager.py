"""
Credits manager — handles persistence across Local/Redis/SQL backends.

Does NOT extend BaseStorage. Reads get_storage() instance type and dispatches
to the right persistence path. In-memory cache with dirty-flush, same pattern
as TokenManager.
"""

import asyncio
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import aiofiles
import orjson

from app.core.config import get_config
from app.core.logger import logger
from app.services.credits.models import UserCredits

# Persistence file for LocalStorage mode
_DATA_DIR = Path(os.getenv("DATA_DIR", str(Path(__file__).parent.parent.parent.parent / "data"))).expanduser()
CREDITS_FILE = _DATA_DIR / "credits.json"

# Flush delay (ms) — batch writes like TokenManager
FLUSH_DELAY_MS = 500


def _now_ms() -> int:
    return int(time.time() * 1000)


def _today_str() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------

def _is_enabled() -> bool:
    return bool(get_config("credits.enabled", True))

def _initial_credits() -> int:
    return int(get_config("credits.initial_credits", 100))

def _daily_checkin_credits() -> int:
    return int(get_config("credits.daily_checkin_credits", 10))

def _image_cost() -> int:
    return int(get_config("credits.image_cost", 10))

def _video_cost() -> int:
    return int(get_config("credits.video_cost", 20))


# ---------------------------------------------------------------------------
# CreditsManager
# ---------------------------------------------------------------------------

class CreditsManager:
    """Singleton that manages user credits with in-memory cache + lazy flush."""

    _instance: Optional["CreditsManager"] = None

    def __init__(self):
        self._users: dict[str, UserCredits] = {}
        self._dirty = False
        self._flush_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()
        self._loaded = False

    # ------------------------------------------------------------------
    # Persistence: load / save dispatched by storage type
    # ------------------------------------------------------------------

    async def _ensure_loaded(self):
        if self._loaded:
            return
        async with self._lock:
            if self._loaded:
                return
            await self._load()
            self._loaded = True

    async def _load(self):
        """Load all user credits from the active storage backend."""
        from app.core.storage import get_storage, LocalStorage, RedisStorage, SQLStorage

        storage = get_storage()

        if isinstance(storage, LocalStorage):
            await self._load_local()
        elif isinstance(storage, RedisStorage):
            await self._load_redis(storage)
        elif isinstance(storage, SQLStorage):
            await self._load_sql(storage)
        else:
            await self._load_local()

        logger.info(f"CreditsManager: loaded {len(self._users)} user(s)")

    async def _load_local(self):
        if not CREDITS_FILE.exists():
            return
        try:
            async with aiofiles.open(CREDITS_FILE, "rb") as f:
                raw = await f.read()
            data = orjson.loads(raw)
            for uid, obj in data.items():
                self._users[uid] = UserCredits(**obj)
        except Exception as e:
            logger.error(f"CreditsManager: load local failed: {e}")

    async def _load_redis(self, storage):
        try:
            keys = await storage.redis.keys("grok2api:credits:*")
            if not keys:
                return
            async with storage.redis.pipeline() as pipe:
                for k in keys:
                    pipe.hgetall(k)
                results = await pipe.execute()
            for k, data in zip(keys, results):
                if not data:
                    continue
                uid = k.replace("grok2api:credits:", "")
                for int_field in ("credits", "total_earned", "total_spent", "created_at", "updated_at"):
                    if data.get(int_field):
                        try:
                            data[int_field] = int(data[int_field])
                        except (ValueError, TypeError):
                            pass
                self._users[uid] = UserCredits(**data)
        except Exception as e:
            logger.error(f"CreditsManager: load redis failed: {e}")

    async def _load_sql(self, storage):
        from sqlalchemy import text
        await self._ensure_sql_table(storage)
        try:
            async with storage.async_session() as session:
                res = await session.execute(text(
                    "SELECT user_id, credits, total_earned, total_spent, "
                    "last_checkin, created_at, updated_at FROM user_credits"
                ))
                for row in res.fetchall():
                    uid, credits, earned, spent, checkin, cat, uat = row
                    self._users[uid] = UserCredits(
                        user_id=uid, credits=credits or 0,
                        total_earned=earned or 0, total_spent=spent or 0,
                        last_checkin=checkin or "", created_at=cat or 0, updated_at=uat or 0,
                    )
        except Exception as e:
            logger.error(f"CreditsManager: load sql failed: {e}")

    async def _ensure_sql_table(self, storage):
        from sqlalchemy import text
        try:
            async with storage.engine.begin() as conn:
                await conn.execute(text("""
                    CREATE TABLE IF NOT EXISTS user_credits (
                        user_id VARCHAR(128) PRIMARY KEY,
                        credits INT DEFAULT 0,
                        total_earned INT DEFAULT 0,
                        total_spent INT DEFAULT 0,
                        last_checkin VARCHAR(10) DEFAULT '',
                        created_at BIGINT DEFAULT 0,
                        updated_at BIGINT DEFAULT 0
                    )
                """))
        except Exception as e:
            logger.error(f"CreditsManager: create table failed: {e}")

    # ------------------------------------------------------------------
    # Save (dirty flush)
    # ------------------------------------------------------------------

    def _mark_dirty(self):
        self._dirty = True
        if self._flush_task is None or self._flush_task.done():
            self._flush_task = asyncio.create_task(self._delayed_flush())

    async def _delayed_flush(self):
        await asyncio.sleep(FLUSH_DELAY_MS / 1000)
        if self._dirty:
            await self._save()
            self._dirty = False

    async def _save(self):
        from app.core.storage import get_storage, LocalStorage, RedisStorage, SQLStorage
        storage = get_storage()

        if isinstance(storage, LocalStorage):
            await self._save_local()
        elif isinstance(storage, RedisStorage):
            await self._save_redis(storage)
        elif isinstance(storage, SQLStorage):
            await self._save_sql(storage)
        else:
            await self._save_local()

    async def _save_local(self):
        try:
            CREDITS_FILE.parent.mkdir(parents=True, exist_ok=True)
            tmp = CREDITS_FILE.with_suffix(".tmp")
            data = {uid: u.model_dump() for uid, u in self._users.items()}
            async with aiofiles.open(tmp, "wb") as f:
                await f.write(orjson.dumps(data, option=orjson.OPT_INDENT_2))
            os.replace(tmp, CREDITS_FILE)
        except Exception as e:
            logger.error(f"CreditsManager: save local failed: {e}")

    async def _save_redis(self, storage):
        try:
            async with storage.redis.pipeline() as pipe:
                for uid, u in self._users.items():
                    key = f"grok2api:credits:{uid}"
                    mapping = {k: str(v) for k, v in u.model_dump().items()}
                    pipe.hset(key, mapping=mapping)
                await pipe.execute()
        except Exception as e:
            logger.error(f"CreditsManager: save redis failed: {e}")

    async def _save_sql(self, storage):
        from sqlalchemy import text
        await self._ensure_sql_table(storage)
        try:
            async with storage.async_session() as session:
                for uid, u in self._users.items():
                    if storage.dialect in ("mysql", "mariadb"):
                        stmt = text(
                            "INSERT INTO user_credits (user_id, credits, total_earned, total_spent, "
                            "last_checkin, created_at, updated_at) "
                            "VALUES (:user_id, :credits, :total_earned, :total_spent, "
                            ":last_checkin, :created_at, :updated_at) "
                            "ON DUPLICATE KEY UPDATE "
                            "credits=VALUES(credits), total_earned=VALUES(total_earned), "
                            "total_spent=VALUES(total_spent), last_checkin=VALUES(last_checkin), "
                            "updated_at=VALUES(updated_at)"
                        )
                    else:
                        stmt = text(
                            "INSERT INTO user_credits (user_id, credits, total_earned, total_spent, "
                            "last_checkin, created_at, updated_at) "
                            "VALUES (:user_id, :credits, :total_earned, :total_spent, "
                            ":last_checkin, :created_at, :updated_at) "
                            "ON CONFLICT (user_id) DO UPDATE SET "
                            "credits=EXCLUDED.credits, total_earned=EXCLUDED.total_earned, "
                            "total_spent=EXCLUDED.total_spent, last_checkin=EXCLUDED.last_checkin, "
                            "updated_at=EXCLUDED.updated_at"
                        )
                    await session.execute(stmt, u.model_dump())
                await session.commit()
        except Exception as e:
            logger.error(f"CreditsManager: save sql failed: {e}")

    # ------------------------------------------------------------------
    # Business logic
    # ------------------------------------------------------------------

    async def ensure_user(self, user_id: str) -> UserCredits:
        """First login: create account with initial credits. Idempotent."""
        await self._ensure_loaded()
        async with self._lock:
            if user_id in self._users:
                return self._users[user_id]
            now = _now_ms()
            initial = _initial_credits()
            u = UserCredits(
                user_id=user_id, credits=initial, total_earned=initial,
                total_spent=0, last_checkin="", created_at=now, updated_at=now,
            )
            self._users[user_id] = u
            self._mark_dirty()
            logger.info(f"Credits: new user '{user_id}' +{initial} initial")
            return u

    async def get_credits(self, user_id: str) -> Optional[UserCredits]:
        await self._ensure_loaded()
        return self._users.get(user_id)

    async def consume(self, user_id: str, amount: int, reason: str = "") -> bool:
        """Deduct credits. Returns False if insufficient balance."""
        if amount <= 0:
            return True
        await self._ensure_loaded()
        async with self._lock:
            u = self._users.get(user_id)
            if not u:
                return False
            if u.credits < amount:
                return False
            u.credits -= amount
            u.total_spent += amount
            u.updated_at = _now_ms()
            self._mark_dirty()
            logger.debug(f"Credits: '{user_id}' -{amount} ({reason}) balance={u.credits}")
            return True

    async def checkin(self, user_id: str) -> tuple[bool, int]:
        """Daily check-in. Returns (success, current_balance)."""
        await self._ensure_loaded()
        async with self._lock:
            u = self._users.get(user_id)
            if not u:
                return False, 0
            today = _today_str()
            if u.last_checkin == today:
                return False, u.credits
            reward = _daily_checkin_credits()
            u.credits += reward
            u.total_earned += reward
            u.last_checkin = today
            u.updated_at = _now_ms()
            self._mark_dirty()
            logger.info(f"Credits: '{user_id}' checkin +{reward} balance={u.credits}")
            return True, u.credits

    async def adjust(self, user_id: str, amount: int) -> Optional[UserCredits]:
        """Admin adjustment (positive or negative)."""
        await self._ensure_loaded()
        async with self._lock:
            u = self._users.get(user_id)
            if not u:
                return None
            u.credits += amount
            if amount > 0:
                u.total_earned += amount
            else:
                u.total_spent += abs(amount)
            u.updated_at = _now_ms()
            self._mark_dirty()
            return u

    async def list_users(self) -> list[UserCredits]:
        await self._ensure_loaded()
        return list(self._users.values())


# ---------------------------------------------------------------------------
# Singleton accessor
# ---------------------------------------------------------------------------

_credits_mgr: Optional[CreditsManager] = None


async def get_credits_manager() -> CreditsManager:
    global _credits_mgr
    if _credits_mgr is None:
        _credits_mgr = CreditsManager()
        await _credits_mgr._ensure_loaded()
    return _credits_mgr


# ---------------------------------------------------------------------------
# Helper: check & deduct credits for OAuth user, pass-through for static key
# ---------------------------------------------------------------------------

async def check_and_consume(token: str, cost_type: str) -> Optional[str]:
    """
    Check if the bearer token belongs to an OAuth user and deduct credits.

    Returns None on success (or non-OAuth user), or an error message string
    if the OAuth user has insufficient credits.

    cost_type: "image" | "video"
    """
    if not _is_enabled():
        return None

    from app.api.v1.public_api.oauth import get_oauth_user_id
    user_id = get_oauth_user_id(token)
    if not user_id:
        return None  # static key user, no credit limit

    cost = _image_cost() if cost_type == "image" else _video_cost()
    mgr = await get_credits_manager()
    ok = await mgr.consume(user_id, cost, reason=cost_type)
    if not ok:
        u = await mgr.get_credits(user_id)
        balance = u.credits if u else 0
        return f"Insufficient credits: need {cost}, have {balance}"
    return None
