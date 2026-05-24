"""Auth helpers — JWT email/password, bcrypt hashing, brute force protection.

Tokens are issued as httpOnly cookies (primary) with Authorization Bearer header
fallback. Uses MongoDB collections: `users`, `login_attempts`.
"""
from __future__ import annotations
import os
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

import bcrypt
import jwt
from fastapi import HTTPException, Request, Response

JWT_ALGORITHM = "HS256"
ACCESS_TTL_MIN = 60 * 12  # 12h — internal tool
REFRESH_TTL_DAYS = 30

MAX_FAILED = 5
LOCKOUT_MIN = 15


def _jwt_secret() -> str:
    s = os.environ.get("JWT_SECRET")
    if not s:
        raise RuntimeError("JWT_SECRET missing in env")
    return s


# ---------------------------------------------------------------------------
# Password hashing
# ---------------------------------------------------------------------------
def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


# ---------------------------------------------------------------------------
# JWT tokens
# ---------------------------------------------------------------------------
def create_access_token(user_id: str, email: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TTL_MIN),
        "type": "access",
    }
    return jwt.encode(payload, _jwt_secret(), algorithm=JWT_ALGORITHM)


def create_refresh_token(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "exp": datetime.now(timezone.utc) + timedelta(days=REFRESH_TTL_DAYS),
        "type": "refresh",
    }
    return jwt.encode(payload, _jwt_secret(), algorithm=JWT_ALGORITHM)


def set_auth_cookies(response: Response, access: str, refresh: str) -> None:
    response.set_cookie("access_token", access, httponly=True, secure=True,
                        samesite="none", max_age=ACCESS_TTL_MIN * 60, path="/")
    response.set_cookie("refresh_token", refresh, httponly=True, secure=True,
                        samesite="none", max_age=REFRESH_TTL_DAYS * 86400, path="/")


def clear_auth_cookies(response: Response) -> None:
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("refresh_token", path="/")


def _extract_token(request: Request) -> Optional[str]:
    tok = request.cookies.get("access_token")
    if tok:
        return tok
    hdr = request.headers.get("Authorization", "")
    if hdr.startswith("Bearer "):
        return hdr[7:]
    return None


def decode_token(token: str, expected_type: str = "access") -> dict:
    payload = jwt.decode(token, _jwt_secret(), algorithms=[JWT_ALGORITHM])
    if payload.get("type") != expected_type:
        raise jwt.InvalidTokenError(f"Wrong token type, expected {expected_type}")
    return payload


# ---------------------------------------------------------------------------
# get_current_user — bound to a db instance via closure in server.py
# ---------------------------------------------------------------------------
async def fetch_user_from_token(request: Request, db) -> dict:
    token = _extract_token(request)
    if not token:
        raise HTTPException(401, "Inte inloggad")
    try:
        payload = decode_token(token, "access")
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token har gått ut")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Ogiltig token")

    user = await db.users.find_one({"id": payload["sub"]}, {"_id": 0, "password_hash": 0})
    if not user:
        raise HTTPException(401, "Användare hittades inte")
    return user


async def fetch_user_optional(request: Request, db) -> Optional[dict]:
    try:
        return await fetch_user_from_token(request, db)
    except HTTPException:
        return None


# ---------------------------------------------------------------------------
# Brute force protection
# ---------------------------------------------------------------------------
def _attempt_key(ip: str, email: str) -> str:
    return f"{ip}:{email.lower()}"


async def is_locked_out(db, ip: str, email: str) -> bool:
    doc = await db.login_attempts.find_one({"id": _attempt_key(ip, email)})
    if not doc:
        return False
    if doc.get("count", 0) < MAX_FAILED:
        return False
    last = doc.get("last_at")
    if not last:
        return False
    last_dt = datetime.fromisoformat(last)
    if datetime.now(timezone.utc) - last_dt > timedelta(minutes=LOCKOUT_MIN):
        # window expired — reset
        await db.login_attempts.delete_one({"id": _attempt_key(ip, email)})
        return False
    return True


async def record_failed_attempt(db, ip: str, email: str) -> None:
    await db.login_attempts.update_one(
        {"id": _attempt_key(ip, email)},
        {"$inc": {"count": 1},
         "$set": {"last_at": datetime.now(timezone.utc).isoformat(),
                  "id": _attempt_key(ip, email)}},
        upsert=True,
    )


async def clear_attempts(db, ip: str, email: str) -> None:
    await db.login_attempts.delete_one({"id": _attempt_key(ip, email)})


# ---------------------------------------------------------------------------
# Admin seeding — idempotent
# ---------------------------------------------------------------------------
async def seed_admin(db) -> None:
    email = (os.environ.get("ADMIN_EMAIL") or "").strip().lower()
    pwd = os.environ.get("ADMIN_PASSWORD") or ""
    name = os.environ.get("ADMIN_NAME") or "Admin"
    if not email or not pwd:
        return

    existing = await db.users.find_one({"email": email})
    if not existing:
        doc = {
            "id": str(uuid.uuid4()),
            "email": email,
            "name": name,
            "role": "admin",
            "password_hash": hash_password(pwd),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await db.users.insert_one(doc)
        return
    # Update password hash if .env changed
    if not verify_password(pwd, existing.get("password_hash", "")):
        await db.users.update_one(
            {"email": email},
            {"$set": {"password_hash": hash_password(pwd)}},
        )
