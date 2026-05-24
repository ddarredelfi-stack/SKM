"""Emergent Object Storage client — file uploads for prospect documents.

Wraps the storage REST API. `storage_key` is initialized once at startup and
reused across requests.
"""
from __future__ import annotations
import asyncio
import logging
import os
import uuid

import requests

logger = logging.getLogger(__name__)

STORAGE_URL = "https://integrations.emergentagent.com/objstore/api/v1/storage"
APP_NAME = "skandia-etablering"

_storage_key: str | None = None

MIME_TYPES = {
    "pdf": "application/pdf",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xls": "application/vnd.ms-excel",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "gif": "image/gif", "webp": "image/webp",
    "txt": "text/plain", "csv": "text/csv", "json": "application/json",
}


def _init_sync() -> str:
    """Synchronous init — runs in a thread."""
    global _storage_key
    if _storage_key:
        return _storage_key
    key = os.environ.get("EMERGENT_LLM_KEY")
    if not key:
        raise RuntimeError("EMERGENT_LLM_KEY missing in env")
    resp = requests.post(
        f"{STORAGE_URL}/init",
        json={"emergent_key": key},
        timeout=30,
    )
    resp.raise_for_status()
    _storage_key = resp.json()["storage_key"]
    return _storage_key


async def init_storage() -> str:
    return await asyncio.to_thread(_init_sync)


def _put_sync(path: str, data: bytes, content_type: str) -> dict:
    key = _init_sync()
    resp = requests.put(
        f"{STORAGE_URL}/objects/{path}",
        headers={"X-Storage-Key": key, "Content-Type": content_type},
        data=data,
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json()


async def put_object(path: str, data: bytes, content_type: str) -> dict:
    return await asyncio.to_thread(_put_sync, path, data, content_type)


def _get_sync(path: str) -> tuple[bytes, str]:
    key = _init_sync()
    resp = requests.get(
        f"{STORAGE_URL}/objects/{path}",
        headers={"X-Storage-Key": key},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.content, resp.headers.get("Content-Type", "application/octet-stream")


async def get_object(path: str) -> tuple[bytes, str]:
    return await asyncio.to_thread(_get_sync, path)


def build_path(user_id: str, prospect_id: str, filename: str) -> str:
    ext = (filename.rsplit(".", 1)[-1] if "." in filename else "bin").lower()
    return f"{APP_NAME}/prospects/{prospect_id}/{user_id}/{uuid.uuid4()}.{ext}"


def guess_content_type(filename: str, fallback: str = "application/octet-stream") -> str:
    ext = (filename.rsplit(".", 1)[-1] if "." in filename else "").lower()
    return MIME_TYPES.get(ext, fallback)
