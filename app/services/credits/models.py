"""Credits data model."""

from pydantic import BaseModel


class UserCredits(BaseModel):
    user_id: str = ""
    credits: int = 0
    total_earned: int = 0
    total_spent: int = 0
    last_checkin: str = ""  # "YYYY-MM-DD"
    created_at: int = 0     # ms timestamp
    updated_at: int = 0     # ms timestamp
