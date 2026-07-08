# Skandiamäklarna Etableringschef-Dashboard — Full Källkod

**Genererad:** 2026-07-08T09:21:42Z

## Stack
- **Backend:** FastAPI + Motor (async MongoDB) + JWT auth + BeautifulSoup scraper
- **Frontend:** React 19 + React Router 7 + Tailwind + Shadcn/UI + Radix + react-leaflet
- **AI:** Claude Sonnet 4.5 via emergentintegrations (Emergent LLM Key)
- **Storage:** Emergent Object Storage (S3-kompatibel via emergentintegrations)
- **Email:** Resend (scaffolded)

## Struktur
```
/app/
├── backend/
│   ├── server.py             # Main FastAPI — all routes
│   ├── auth.py               # JWT + bcrypt + brute-force
│   ├── ai_service.py         # Claude Sonnet 4.5 wrapper
│   ├── scraper.py            # skandiamaklarna.se scraper
│   ├── storage_service.py    # Object storage wrapper
│   ├── email_service.py      # Resend wrapper
│   ├── seed_data.py          # Baseline seed data
│   ├── municipalities_data.py# Sweden municipalities master list
│   └── .env                  # (INTE inkluderad — se .env-mall nedan)
└── frontend/src/
    ├── App.js                # Router + AuthProvider
    ├── index.js, index.css   # Entry + globala styles
    ├── lib/
    │   ├── api.js            # Axios wrapper + konstanter
    │   ├── auth.jsx          # AuthContext
    │   └── utils.js
    ├── components/           # Sidebar, ProspectSheet, DiscoverySheet, etc.
    └── pages/                # Dashboard, Pipeline, Offices, OfficeDetail, ...
```

## .env-mallar (utfyll själv)

**backend/.env:**
```
MONGO_URL=mongodb://localhost:27017
DB_NAME=skandia_etablering
JWT_SECRET=<generera random>
ADMIN_EMAIL=delfi@skandiamaklarna.se
ADMIN_PASSWORD=Etablering2026
ADMIN_NAME=Delfi
EMERGENT_LLM_KEY=<from Emergent>
RESEND_API_KEY=<optional>
REMINDER_RECIPIENT=<optional email>
```

**frontend/.env:**
```
REACT_APP_BACKEND_URL=https://your-preview.emergentagent.com
```

---

# BACKEND


## `backend/server.py`

```python
"""Etableringschef-dashboard backend for Skandiamäklarna.

FastAPI + MongoDB. Multi-user with JWT email/password auth (httpOnly cookies +
Authorization Bearer fallback). All /api/* routes require auth except
/api/auth/login, /api/auth/refresh, /api/ (health).
"""
from __future__ import annotations
import csv
import io
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, EmailStr, Field
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

from ai_service import generate_brief, generate_discovery_strategy  # noqa: E402
from auth import (  # noqa: E402
    clear_attempts,
    clear_auth_cookies,
    create_access_token,
    create_refresh_token,
    decode_token,
    fetch_user_from_token,
    hash_password,
    is_locked_out,
    record_failed_attempt,
    seed_admin,
    set_auth_cookies,
    verify_password,
)
from email_service import build_reminder_html, send_reminder  # noqa: E402
from municipalities_data import MUNICIPALITIES  # noqa: E402
from scraper import scrape_offices, to_broker_docs, to_office_doc  # noqa: E402
from seed_data import (  # noqa: E402
    build_activity_seed,
    build_goals,
    build_prospects,
    build_seed,
)
from storage_service import (  # noqa: E402
    build_path,
    get_object,
    guess_content_type,
    init_storage,
    put_object,
)

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
logger = logging.getLogger(__name__)

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

PIPELINE_STATUSES = [
    "Identifierad",
    "Kontaktad",
    "Möte bokat",
    "Förhandling",
    "Signerad",
    "Onboardad",
]

app = FastAPI(title="Skandiamäklarna Etablering Dashboard")
api_public = APIRouter(prefix="/api")  # no auth: login/refresh/health


async def current_user(request: Request) -> dict:
    return await fetch_user_from_token(request, db)


async def admin_only(user: dict = Depends(current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(403, "Endast admin")
    return user


api = APIRouter(prefix="/api", dependencies=[Depends(current_user)])


def _id() -> str:
    return str(uuid.uuid4())


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _ensure_seed():
    """If empty, seed offices/brokers/listings/prospects/goals."""
    if await db.offices.count_documents({}) == 0:
        offices, brokers, listings = build_seed()
        if offices:
            await db.offices.insert_many(offices)
        if brokers:
            await db.brokers.insert_many(brokers)
        if listings:
            await db.listings.insert_many(listings)
        prospects = build_prospects(offices)
        if prospects:
            await db.prospects.insert_many(prospects)
        goals = build_goals()
        if goals:
            await db.goals.insert_many(goals)
        log = build_activity_seed(prospects)
        if log:
            await db.activity.insert_many(log)
        logger.info("Seeded %d offices, %d brokers, %d listings, %d prospects",
                    len(offices), len(brokers), len(listings), len(prospects))


@app.on_event("startup")
async def on_startup():
    await _ensure_seed()
    await seed_admin(db)
    try:
        await db.users.create_index("email", unique=True)
        await db.login_attempts.create_index("id")
        await db.files.create_index("prospect_id")
        await db.onboarding.create_index("prospect_id")
    except Exception as e:
        logger.warning(f"Index create skipped: {e}")
    try:
        await init_storage()
        logger.info("Object storage initialized")
    except Exception as e:
        logger.warning(f"Storage init skipped: {e}")


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------
class ProspectIn(BaseModel):
    name: str
    type: str = "broker"  # broker | office
    current_agency: str = ""
    city: str = ""
    region: str = ""
    phone: str = ""
    email: str = ""
    linkedin: str = ""
    status: str = "Identifierad"
    notes: str = ""
    next_step: str = ""
    next_step_date: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    owner_id: Optional[str] = None  # if None, defaults to current user
    source: str = "Annat"
    source_detail: str = ""
    referred_by: str = ""
    office_id: Optional[str] = None  # explicit link to an office (preferred over city match)
    # Anbudsekonomi (deal economics)
    signing_bonus: Optional[int] = None
    commission_split: str = ""
    guaranteed_salary: Optional[int] = None
    establishment_grant: Optional[int] = None
    start_date: Optional[str] = None
    contract_term_months: Optional[int] = None
    expected_first_year_revenue: Optional[int] = None
    economy_notes: str = ""


class ProspectUpdate(BaseModel):
    name: Optional[str] = None
    type: Optional[str] = None
    current_agency: Optional[str] = None
    city: Optional[str] = None
    region: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    linkedin: Optional[str] = None
    status: Optional[str] = None
    notes: Optional[str] = None
    next_step: Optional[str] = None
    next_step_date: Optional[str] = None
    tags: Optional[list[str]] = None
    owner_id: Optional[str] = None  # use empty-string to unset
    source: Optional[str] = None
    source_detail: Optional[str] = None
    referred_by: Optional[str] = None
    office_id: Optional[str] = None  # empty-string to unset
    signing_bonus: Optional[int] = None
    commission_split: Optional[str] = None
    guaranteed_salary: Optional[int] = None
    establishment_grant: Optional[int] = None
    start_date: Optional[str] = None
    contract_term_months: Optional[int] = None
    expected_first_year_revenue: Optional[int] = None
    economy_notes: Optional[str] = None


class StatusUpdate(BaseModel):
    status: str


class LostRequest(BaseModel):
    lost_to_agency: str
    lost_reason: str = ""


class OnboardingItemUpdate(BaseModel):
    title: Optional[str] = None
    completed: Optional[bool] = None
    notes: Optional[str] = None
    due_offset_days: Optional[int] = None


class OnboardingItemCreate(BaseModel):
    title: str
    due_offset_days: int = 0
    notes: str = ""


class OfficeGoalUpdate(BaseModel):
    target_hires: Optional[int] = None
    deadline: Optional[str] = None  # ISO date
    status_note: Optional[str] = None
    needs: Optional[list[str]] = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserCreate(BaseModel):
    email: EmailStr
    password: str
    name: str
    role: str = "member"  # admin | member


class UserUpdate(BaseModel):
    name: Optional[str] = None
    role: Optional[str] = None
    password: Optional[str] = None


class GoalIn(BaseModel):
    title: str
    target: int
    current: int = 0
    metric: str = ""
    deadline: Optional[str] = None


class GoalUpdate(BaseModel):
    title: Optional[str] = None
    target: Optional[int] = None
    current: Optional[int] = None
    metric: Optional[str] = None
    deadline: Optional[str] = None


class ResearchRequest(BaseModel):
    prospect_id: Optional[str] = None
    name: str
    city: str = ""
    current_agency: str = ""
    notes: str = ""


class SendReminderRequest(BaseModel):
    prospect_id: str
    recipient: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
async def _activity(kind: str, message: str, actor: Optional[dict] = None, **kwargs: Any):
    doc = {
        "id": _id(),
        "kind": kind,
        "message": message,
        "created_at": _now(),
        "prospect_id": kwargs.get("prospect_id"),
        "prospect_name": kwargs.get("prospect_name"),
        "from_status": kwargs.get("from_status"),
        "to_status": kwargs.get("to_status"),
        "actor_id": (actor or {}).get("id"),
        "actor_name": (actor or {}).get("name"),
    }
    await db.activity.insert_one(doc)


async def _resolve_owner(owner_id: Optional[str]) -> tuple[Optional[str], str]:
    """Look up a user by id and return (id, name). Returns (None, '') if not found
    or if owner_id is empty/None."""
    if not owner_id:
        return None, ""
    u = await db.users.find_one({"id": owner_id}, {"_id": 0, "name": 1})
    if not u:
        return None, ""
    return owner_id, u.get("name", "")


async def _resolve_office(office_id: Optional[str]) -> tuple[Optional[str], str]:
    """Look up an office by id and return (id, name)."""
    if not office_id:
        return None, ""
    o = await db.offices.find_one({"id": office_id}, {"_id": 0, "name": 1})
    if not o:
        return None, ""
    return office_id, o.get("name", "")


def _strip_id(doc: dict) -> dict:
    doc.pop("_id", None)
    return doc


# ---------------------------------------------------------------------------
# Dashboard / KPIs
# ---------------------------------------------------------------------------
@api.get("/dashboard/kpis")
async def kpis(stale_days: int = 14):
    from datetime import timedelta
    offices = await db.offices.count_documents({})
    brokers = await db.brokers.count_documents({})
    listings = await db.listings.count_documents({})
    prospects_total = await db.prospects.count_documents({"is_lost": {"$ne": True}})

    pipeline = {}
    for s in PIPELINE_STATUSES:
        pipeline[s] = await db.prospects.count_documents({"status": s, "is_lost": {"$ne": True}})

    # Regions covered
    region_cursor = db.offices.aggregate([{"$group": {"_id": "$region"}}])
    regions = [r["_id"] async for r in region_cursor]

    goals = [_strip_id(g) async for g in db.goals.find({}, {"_id": 0})]
    activity = [_strip_id(a) async for a in
                db.activity.find({}, {"_id": 0}).sort("created_at", -1).limit(15)]

    lost_total = await db.prospects.count_documents({"is_lost": True})
    cutoff = (datetime.now(timezone.utc) - timedelta(days=stale_days)).isoformat()
    stale_count = await db.prospects.count_documents({
        "is_lost": {"$ne": True},
        "status": {"$ne": "Onboardad"},
        "updated_at": {"$lt": cutoff},
    })

    # Pipeline economic value = sum of expected_first_year_revenue + signing_bonus
    # across active (non-lost) prospects.
    pipeline_value = 0
    async for p in db.prospects.find(
        {"is_lost": {"$ne": True}, "status": {"$ne": "Onboardad"}},
        {"_id": 0, "expected_first_year_revenue": 1, "signing_bonus": 1},
    ):
        pipeline_value += int(p.get("expected_first_year_revenue") or 0)
        pipeline_value += int(p.get("signing_bonus") or 0)

    return {
        "offices": offices,
        "brokers": brokers,
        "listings": listings,
        "prospects_total": prospects_total,
        "pipeline": pipeline,
        "regions_covered": len([r for r in regions if r]),
        "goals": goals,
        "activity": activity,
        "lost_total": lost_total,
        "stale_count": stale_count,
        "stale_days": stale_days,
        "pipeline_value": pipeline_value,
        "as_of": _now(),
    }


@api.get("/dashboard/insights")
async def insights(stale_days: int = Query(14, ge=1, le=180),
                   user: dict = Depends(current_user)):
    from datetime import timedelta

    # Source breakdown (active prospects only)
    sources = []
    cursor = db.prospects.aggregate([
        {"$match": {"is_lost": {"$ne": True}}},
        {"$group": {"_id": "$source", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ])
    async for doc in cursor:
        sources.append({"source": doc["_id"] or "Annat", "count": doc["count"]})

    # Lost breakdown (which competitors stole prospects)
    lost_breakdown = []
    cursor = db.prospects.aggregate([
        {"$match": {"is_lost": True}},
        {"$group": {"_id": "$lost_to_agency", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ])
    async for doc in cursor:
        lost_breakdown.append({"agency": doc["_id"] or "Okänd", "count": doc["count"]})

    # Top stale prospects (top 5 oldest)
    cutoff_iso = (datetime.now(timezone.utc) - timedelta(days=stale_days)).isoformat()
    stale_items = []
    async for p in db.prospects.find(
        {
            "is_lost": {"$ne": True},
            "status": {"$ne": "Onboardad"},
            "updated_at": {"$lt": cutoff_iso},
        },
        {"_id": 0},
    ).sort("updated_at", 1).limit(5):
        stale_items.append(_strip_id(p))

    return {
        "sources": sources,
        "lost_breakdown": lost_breakdown,
        "top_stale": stale_items,
        "stale_days": stale_days,
    }


# ---------------------------------------------------------------------------
# Offices / Brokers / Listings (read-only)
# ---------------------------------------------------------------------------
@api.get("/offices")
async def list_offices(q: str = "", city: str = "", region: str = ""):
    flt: dict[str, Any] = {}
    if city:
        flt["city"] = city
    if region:
        flt["region"] = region
    if q:
        flt["$or"] = [
            {"name": {"$regex": q, "$options": "i"}},
            {"city": {"$regex": q, "$options": "i"}},
            {"manager": {"$regex": q, "$options": "i"}},
            {"address": {"$regex": q, "$options": "i"}},
        ]
    items = [_strip_id(o) async for o in db.offices.find(flt, {"_id": 0}).sort("name", 1)]
    return {"items": items, "total": len(items)}


@api.get("/offices/{office_id}")
async def get_office(office_id: str, user: dict = Depends(current_user)):
    office = await db.offices.find_one({"id": office_id}, {"_id": 0})
    if not office:
        raise HTTPException(404, "Kontor hittades inte")
    brokers = [_strip_id(b) async for b in
               db.brokers.find({"office_id": office_id}, {"_id": 0}).sort("name", 1)]
    listings = [_strip_id(l) async for l in
                db.listings.find({"office_id": office_id}, {"_id": 0}).limit(50)]

    # Prospects linked to this office: explicit office_id wins; otherwise fall
    # back to city matching for legacy/unlinked prospects.
    city_lc = (office.get("city") or "").lower()
    prospects = []
    seen_ids = set()
    async for p in db.prospects.find(
        {"office_id": office_id, "is_lost": {"$ne": True}},
        {"_id": 0},
    ).sort("updated_at", -1):
        prospects.append(_strip_id(p))
        seen_ids.add(p["id"])
    if city_lc:
        async for p in db.prospects.find(
            {
                "city": {"$regex": f"^{city_lc}$", "$options": "i"},
                "is_lost": {"$ne": True},
                "$or": [{"office_id": None}, {"office_id": ""}, {"office_id": {"$exists": False}}],
            },
            {"_id": 0},
        ).sort("updated_at", -1):
            if p["id"] not in seen_ids:
                prospects.append(_strip_id(p))
                seen_ids.add(p["id"])

    # Recruitment goal
    goal = await db.office_goals.find_one({"office_id": office_id}, {"_id": 0})

    # Auto-derived counts
    signed_count = sum(1 for p in prospects if p.get("status") in ("Signerad", "Onboardad"))
    onboarded_count = sum(1 for p in prospects if p.get("status") == "Onboardad")
    in_pipeline = sum(1 for p in prospects if p.get("status") not in ("Onboardad",))

    # Activity for prospects linked to this office (last 25)
    pids = [p["id"] for p in prospects]
    timeline = []
    if pids:
        async for a in db.activity.find(
            {"prospect_id": {"$in": pids}},
            {"_id": 0},
        ).sort("created_at", -1).limit(25):
            timeline.append(_strip_id(a))

    return {
        "office": office,
        "brokers": brokers,
        "listings": listings,
        "prospects": prospects,
        "goal": _strip_id(goal) if goal else None,
        "kpis": {
            "broker_count": len(brokers),
            "listing_count": len(listings),
            "active_prospects": in_pipeline,
            "signed_or_onboarded": signed_count,
            "onboarded": onboarded_count,
        },
        "timeline": timeline,
    }


@api.put("/offices/{office_id}/recruitment")
async def update_office_goal(office_id: str,
                             body: OfficeGoalUpdate,
                             user: dict = Depends(current_user)):
    office = await db.offices.find_one({"id": office_id}, {"_id": 0})
    if not office:
        raise HTTPException(404, "Kontor hittades inte")
    existing = await db.office_goals.find_one({"office_id": office_id}, {"_id": 0})
    payload = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if existing:
        payload["updated_at"] = _now()
        payload["updated_by_id"] = user["id"]
        payload["updated_by_name"] = user["name"]
        await db.office_goals.update_one({"office_id": office_id}, {"$set": payload})
    else:
        payload = {
            "id": _id(),
            "office_id": office_id,
            "target_hires": payload.get("target_hires", 0),
            "deadline": payload.get("deadline"),
            "status_note": payload.get("status_note", ""),
            "needs": payload.get("needs", []),
            "created_at": _now(),
            "updated_at": _now(),
            "updated_by_id": user["id"],
            "updated_by_name": user["name"],
        }
        await db.office_goals.insert_one(payload)
    await _activity(
        "office_goal_updated",
        f"Rekryteringsmål uppdaterat för {office['name']}",
        actor=user,
    )
    g = await db.office_goals.find_one({"office_id": office_id}, {"_id": 0})
    return _strip_id(g)


@api.post("/offices/{office_id}/link-city-prospects")
async def link_city_prospects(office_id: str, user: dict = Depends(current_user)):
    """Bulk-assign all prospects in this office's city (without explicit office_id)
    to this office. Used for migrating legacy city-matched prospects."""
    office = await db.offices.find_one({"id": office_id}, {"_id": 0})
    if not office:
        raise HTTPException(404, "Kontor hittades inte")
    city = office.get("city") or ""
    if not city:
        raise HTTPException(400, "Kontor saknar stad")

    res = await db.prospects.update_many(
        {
            "city": {"$regex": f"^{city}$", "$options": "i"},
            "is_lost": {"$ne": True},
            "$or": [
                {"office_id": None},
                {"office_id": ""},
                {"office_id": {"$exists": False}},
            ],
        },
        {"$set": {
            "office_id": office_id,
            "office_name": office["name"],
            "updated_at": _now(),
        }},
    )
    if res.modified_count:
        await _activity(
            "bulk_office_link",
            f"{res.modified_count} prospekt kopplade till {office['name']}",
            actor=user,
        )
    return {"linked": res.modified_count, "office_id": office_id, "office_name": office["name"]}


@api.get("/dashboard/office-recruitment")
async def dashboard_office_recruitment(user: dict = Depends(current_user)):
    """Aggregated rollup of all office recruitment goals — for dashboard."""
    offices = [_strip_id(o) async for o in db.offices.find({}, {"_id": 0})]
    goals_map = {}
    async for g in db.office_goals.find({}, {"_id": 0}):
        goals_map[g["office_id"]] = g

    # Pre-fetch prospect status counts per (office_id || city)
    # Explicit office_id wins; legacy prospects fall back to city.
    office_status_counts: dict[str, dict[str, int]] = {}
    city_status_counts: dict[str, dict[str, int]] = {}
    async for p in db.prospects.find(
        {"is_lost": {"$ne": True}},
        {"_id": 0, "city": 1, "status": 1, "office_id": 1},
    ):
        if p.get("office_id"):
            target = office_status_counts.setdefault(p["office_id"], {})
        else:
            key = (p.get("city") or "").lower()
            if not key:
                continue
            target = city_status_counts.setdefault(key, {})
        target[p["status"]] = target.get(p["status"], 0) + 1

    rows = []
    total_target = total_signed = total_in_pipeline = 0
    behind = on_track = no_goal = 0
    all_needs = []

    for o in offices:
        city = (o.get("city") or "").lower()
        # Sum explicit office matches + legacy city matches
        counts: dict[str, int] = {}
        for src in (office_status_counts.get(o["id"], {}), city_status_counts.get(city, {})):
            for k, v in src.items():
                counts[k] = counts.get(k, 0) + v
        signed = counts.get("Signerad", 0) + counts.get("Onboardad", 0)
        in_pipeline = sum(v for k, v in counts.items() if k != "Onboardad")
        g = goals_map.get(o["id"])
        target = (g or {}).get("target_hires") or 0
        deadline = (g or {}).get("deadline")
        needs = (g or {}).get("needs") or []
        status_note = (g or {}).get("status_note") or ""

        status = "no_goal"
        if target > 0:
            ratio = signed / target if target else 0
            status = "on_track" if ratio >= 0.5 else "behind"
        if target == 0:
            no_goal += 1
        elif status == "on_track":
            on_track += 1
        else:
            behind += 1

        total_target += target
        total_signed += signed
        total_in_pipeline += in_pipeline
        all_needs.extend([(o["name"], n) for n in needs])

        rows.append({
            "office_id": o["id"],
            "office_name": o["name"],
            "city": o.get("city", ""),
            "region": o.get("region", ""),
            "target_hires": target,
            "current_hires": signed,
            "in_pipeline": in_pipeline,
            "deadline": deadline,
            "needs": needs,
            "status_note": status_note,
            "status": status,
        })

    rows.sort(key=lambda r: (r["status"] != "behind", -r["target_hires"], r["office_name"]))
    return {
        "rows": rows,
        "totals": {
            "offices": len(offices),
            "with_goal": len(offices) - no_goal,
            "no_goal": no_goal,
            "on_track": on_track,
            "behind": behind,
            "total_target": total_target,
            "total_signed": total_signed,
            "total_in_pipeline": total_in_pipeline,
            "open_needs": len(all_needs),
        },
        "open_needs": [{"office_name": n[0], "need": n[1]} for n in all_needs],
    }


@api.get("/brokers")
async def list_brokers(q: str = "", city: str = "", office_id: str = "",
                       limit: int = Query(500, le=2000)):
    flt: dict[str, Any] = {}
    if city:
        flt["city"] = city
    if office_id:
        flt["office_id"] = office_id
    if q:
        flt["$or"] = [
            {"name": {"$regex": q, "$options": "i"}},
            {"city": {"$regex": q, "$options": "i"}},
            {"office_name": {"$regex": q, "$options": "i"}},
            {"email": {"$regex": q, "$options": "i"}},
        ]
    items = [_strip_id(b) async for b in
             db.brokers.find(flt, {"_id": 0}).sort("name", 1).limit(limit)]
    return {"items": items, "total": len(items)}


@api.get("/listings")
async def list_listings(q: str = "", city: str = "", broker_id: str = "",
                        type_: str = Query("", alias="type"),
                        limit: int = Query(200, le=2000)):
    flt: dict[str, Any] = {}
    if city:
        flt["city"] = city
    if broker_id:
        flt["broker_id"] = broker_id
    if type_:
        flt["type"] = type_
    if q:
        flt["$or"] = [
            {"address": {"$regex": q, "$options": "i"}},
            {"broker_name": {"$regex": q, "$options": "i"}},
            {"office_name": {"$regex": q, "$options": "i"}},
        ]
    items = [_strip_id(l) async for l in db.listings.find(flt, {"_id": 0}).limit(limit)]
    return {"items": items, "total": len(items)}


# ---------------------------------------------------------------------------
# Prospects (CRUD + kanban)
# ---------------------------------------------------------------------------
@api.get("/prospects")
async def list_prospects(q: str = "", status: str = "", city: str = "",
                         owner: str = "", source: str = "",
                         office_id: str = "",
                         include_lost: bool = False,
                         user: dict = Depends(current_user)):
    flt: dict[str, Any] = {}
    if not include_lost:
        flt["is_lost"] = {"$ne": True}
    if status:
        flt["status"] = status
    if city:
        flt["city"] = city
    if source:
        flt["source"] = source
    if office_id:
        flt["office_id"] = office_id
    if owner == "me":
        flt["owner_id"] = user["id"]
    elif owner == "unassigned":
        flt["$or"] = [{"owner_id": None}, {"owner_id": ""}, {"owner_id": {"$exists": False}}]
    elif owner:
        flt["owner_id"] = owner
    if q:
        flt.setdefault("$and", []).append({
            "$or": [
                {"name": {"$regex": q, "$options": "i"}},
                {"city": {"$regex": q, "$options": "i"}},
                {"current_agency": {"$regex": q, "$options": "i"}},
                {"email": {"$regex": q, "$options": "i"}},
            ]
        })
    items = [_strip_id(p) async for p in
             db.prospects.find(flt, {"_id": 0}).sort("updated_at", -1)]
    # Group by status for kanban convenience
    grouped = {s: [] for s in PIPELINE_STATUSES}
    for p in items:
        s = p.get("status")
        if s in grouped:
            grouped[s].append(p)
    return {"items": items, "grouped": grouped, "statuses": PIPELINE_STATUSES, "total": len(items)}


@api.post("/prospects")
async def create_prospect(body: ProspectIn, user: dict = Depends(current_user)):
    if body.status not in PIPELINE_STATUSES:
        raise HTTPException(400, "Ogiltig status")
    doc = body.model_dump()
    # Owner defaults to current user when not provided
    if doc.get("owner_id"):
        oid, oname = await _resolve_owner(doc["owner_id"])
        doc["owner_id"] = oid
        doc["owner_name"] = oname
    else:
        doc["owner_id"] = user["id"]
        doc["owner_name"] = user["name"]
    # Office resolution (denormalize office_name for display)
    if doc.get("office_id"):
        ofid, ofname = await _resolve_office(doc["office_id"])
        doc["office_id"] = ofid
        doc["office_name"] = ofname
    else:
        doc["office_name"] = ""
    doc["id"] = _id()
    doc["created_at"] = _now()
    doc["updated_at"] = _now()
    doc["ai_brief"] = None
    await db.prospects.insert_one(doc)
    await _activity("created", f"Nytt prospekt: {doc['name']}",
                    actor=user, prospect_id=doc["id"], prospect_name=doc["name"])
    return _strip_id(doc)


@api.get("/prospects/{pid}")
async def get_prospect(pid: str):
    p = await db.prospects.find_one({"id": pid}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Prospekt hittades inte")
    return _strip_id(p)


@api.patch("/prospects/{pid}")
async def update_prospect(pid: str, body: ProspectUpdate, user: dict = Depends(current_user)):
    existing = await db.prospects.find_one({"id": pid}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Prospekt hittades inte")
    updates = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if "status" in updates and updates["status"] not in PIPELINE_STATUSES:
        raise HTTPException(400, "Ogiltig status")
    if "owner_id" in updates:
        oid, oname = await _resolve_owner(updates["owner_id"])
        updates["owner_id"] = oid
        updates["owner_name"] = oname
    if "office_id" in updates:
        ofid, ofname = await _resolve_office(updates["office_id"])
        updates["office_id"] = ofid
        updates["office_name"] = ofname
    updates["updated_at"] = _now()
    await db.prospects.update_one({"id": pid}, {"$set": updates})
    if "status" in updates and updates["status"] != existing.get("status"):
        await _activity("status_change",
                        f"{existing['name']}: {existing.get('status')} → {updates['status']}",
                        actor=user, prospect_id=pid, prospect_name=existing["name"],
                        from_status=existing.get("status"), to_status=updates["status"])
    if "owner_id" in updates and updates["owner_id"] != existing.get("owner_id"):
        await _activity(
            "assigned",
            f"{existing['name']} tilldelad {updates.get('owner_name') or '(ingen)'}",
            actor=user, prospect_id=pid, prospect_name=existing["name"],
        )
    if "office_id" in updates and updates["office_id"] != existing.get("office_id"):
        await _activity(
            "office_linked",
            f"{existing['name']} kopplad till {updates.get('office_name') or '(inget kontor)'}",
            actor=user, prospect_id=pid, prospect_name=existing["name"],
        )
    p = await db.prospects.find_one({"id": pid}, {"_id": 0})
    return _strip_id(p)


@api.patch("/prospects/{pid}/status")
async def update_status(pid: str, body: StatusUpdate, user: dict = Depends(current_user)):
    return await update_prospect(pid, ProspectUpdate(status=body.status), user)


@api.delete("/prospects/{pid}")
async def delete_prospect(pid: str, user: dict = Depends(current_user)):
    existing = await db.prospects.find_one({"id": pid}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Prospekt hittades inte")
    await db.prospects.delete_one({"id": pid})
    await _activity("deleted", f"Prospekt borttaget: {existing['name']}",
                    actor=user, prospect_id=pid, prospect_name=existing["name"])
    return {"ok": True}


@api.post("/prospects/{pid}/lost")
async def mark_lost(pid: str, body: LostRequest, user: dict = Depends(current_user)):
    existing = await db.prospects.find_one({"id": pid}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Prospekt hittades inte")
    if not body.lost_to_agency.strip():
        raise HTTPException(400, "Kedja måste anges")
    await db.prospects.update_one(
        {"id": pid},
        {"$set": {
            "is_lost": True,
            "lost_to_agency": body.lost_to_agency.strip(),
            "lost_reason": body.lost_reason.strip(),
            "lost_at": _now(),
            "updated_at": _now(),
        }},
    )
    await _activity(
        "lost",
        f"{existing['name']} förlorad till {body.lost_to_agency}",
        actor=user, prospect_id=pid, prospect_name=existing["name"],
    )
    p = await db.prospects.find_one({"id": pid}, {"_id": 0})
    return _strip_id(p)


@api.post("/prospects/{pid}/restore")
async def restore_prospect(pid: str, user: dict = Depends(current_user)):
    existing = await db.prospects.find_one({"id": pid}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Prospekt hittades inte")
    await db.prospects.update_one(
        {"id": pid},
        {"$set": {
            "is_lost": False,
            "lost_to_agency": "",
            "lost_reason": "",
            "lost_at": None,
            "updated_at": _now(),
        }},
    )
    await _activity(
        "restored",
        f"{existing['name']} återställd till pipeline",
        actor=user, prospect_id=pid, prospect_name=existing["name"],
    )
    p = await db.prospects.find_one({"id": pid}, {"_id": 0})
    return _strip_id(p)


@api.get("/stale-prospects")
async def stale_prospects(days: int = Query(14, ge=1, le=180),
                          user: dict = Depends(current_user)):
    from datetime import timedelta
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    items = []
    async for p in db.prospects.find(
        {
            "is_lost": {"$ne": True},
            "status": {"$ne": "Onboardad"},
            "updated_at": {"$lt": cutoff},
        },
        {"_id": 0},
    ).sort("updated_at", 1):
        items.append(_strip_id(p))
    return {"items": items, "total": len(items), "cutoff": cutoff, "days": days}


# ---------------------------------------------------------------------------
# Prospect files (object storage)
# ---------------------------------------------------------------------------
ALLOWED_FILE_EXT = {"pdf", "doc", "docx", "xls", "xlsx", "png", "jpg", "jpeg",
                    "gif", "webp", "txt", "csv", "json"}
MAX_FILE_SIZE = 15 * 1024 * 1024  # 15 MB


@api.post("/prospects/{pid}/files")
async def upload_prospect_file(pid: str,
                               file: UploadFile = File(...),
                               user: dict = Depends(current_user)):
    prospect = await db.prospects.find_one({"id": pid}, {"_id": 0})
    if not prospect:
        raise HTTPException(404, "Prospekt hittades inte")
    filename = file.filename or "file"
    ext = (filename.rsplit(".", 1)[-1] if "." in filename else "").lower()
    if ext not in ALLOWED_FILE_EXT:
        raise HTTPException(400, f"Filtypen .{ext} stöds inte")
    data = await file.read()
    if len(data) > MAX_FILE_SIZE:
        raise HTTPException(413, "Filen är för stor (max 15 MB)")
    if not data:
        raise HTTPException(400, "Tom fil")
    path = build_path(user["id"], pid, filename)
    content_type = file.content_type or guess_content_type(filename)
    try:
        result = await put_object(path, data, content_type)
    except Exception as e:
        logger.exception("Object storage upload failed")
        raise HTTPException(500, f"Uppladdning misslyckades: {e}")

    record = {
        "id": _id(),
        "prospect_id": pid,
        "storage_path": result.get("path", path),
        "original_filename": filename,
        "content_type": content_type,
        "size": result.get("size", len(data)),
        "uploaded_by_id": user["id"],
        "uploaded_by_name": user["name"],
        "uploaded_at": _now(),
        "is_deleted": False,
    }
    await db.files.insert_one(record)
    await _activity("file_uploaded", f"Fil uppladdad till {prospect['name']}: {filename}",
                    actor=user, prospect_id=pid, prospect_name=prospect["name"])
    return _strip_id(record)


@api.get("/prospects/{pid}/files")
async def list_prospect_files(pid: str, user: dict = Depends(current_user)):
    items = []
    async for f in db.files.find(
        {"prospect_id": pid, "is_deleted": False},
        {"_id": 0},
    ).sort("uploaded_at", -1):
        items.append(_strip_id(f))
    return {"items": items, "total": len(items)}


@api.get("/files/{file_id}/download")
async def download_file(file_id: str, user: dict = Depends(current_user)):
    record = await db.files.find_one({"id": file_id, "is_deleted": False}, {"_id": 0})
    if not record:
        raise HTTPException(404, "Fil hittades inte")
    try:
        data, ct = await get_object(record["storage_path"])
    except Exception as e:
        logger.exception("Object storage download failed")
        raise HTTPException(500, f"Nedladdning misslyckades: {e}")
    safe_name = record["original_filename"].replace('"', '_')
    return Response(
        content=data,
        media_type=record.get("content_type", ct),
        headers={"Content-Disposition": f'attachment; filename="{safe_name}"'},
    )


@api.delete("/files/{file_id}")
async def delete_file(file_id: str, user: dict = Depends(current_user)):
    record = await db.files.find_one({"id": file_id, "is_deleted": False}, {"_id": 0})
    if not record:
        raise HTTPException(404, "Fil hittades inte")
    await db.files.update_one(
        {"id": file_id},
        {"$set": {"is_deleted": True, "deleted_at": _now(), "deleted_by_id": user["id"]}},
    )
    await _activity(
        "file_deleted",
        f"Fil borttagen: {record['original_filename']}",
        actor=user, prospect_id=record["prospect_id"],
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Onboarding checklist
# ---------------------------------------------------------------------------
DEFAULT_ONBOARDING_TEMPLATE = [
    {"title": "Skicka välkomstmejl med kontrakt-bekräftelse", "due_offset_days": 0},
    {"title": "Beställ IT-access (CRM, Hemnet, mejl, telefoni)", "due_offset_days": 3},
    {"title": "Boka introduktion med kontorschef och team", "due_offset_days": 5},
    {"title": "Beställ visitkort, skylt och brand-paket", "due_offset_days": 7},
    {"title": "Tilldela mentor", "due_offset_days": 7},
    {"title": "GDPR- och compliance-utbildning genomförd", "due_offset_days": 14},
    {"title": "30-dagars check-in", "due_offset_days": 30},
    {"title": "60-dagars check-in", "due_offset_days": 60},
    {"title": "90-dagars check-in + utvärdering", "due_offset_days": 90},
    {"title": "PR-launch / lokal marknadsföring", "due_offset_days": 14},
    {"title": "Första objektsintag", "due_offset_days": 30},
]


@api.get("/prospects/{pid}/onboarding")
async def list_onboarding(pid: str, user: dict = Depends(current_user)):
    items = []
    async for it in db.onboarding.find(
        {"prospect_id": pid},
        {"_id": 0},
    ).sort("due_offset_days", 1):
        items.append(_strip_id(it))
    return {"items": items, "total": len(items)}


@api.post("/prospects/{pid}/onboarding/init")
async def init_onboarding(pid: str, user: dict = Depends(current_user)):
    """Create the default onboarding checklist for a prospect.
    Idempotent: returns existing items if already initialized."""
    prospect = await db.prospects.find_one({"id": pid}, {"_id": 0})
    if not prospect:
        raise HTTPException(404, "Prospekt hittades inte")
    existing = await db.onboarding.count_documents({"prospect_id": pid})
    if existing:
        return await list_onboarding(pid, user)

    start_date = prospect.get("start_date") or _now()
    try:
        start_dt = datetime.fromisoformat(start_date.replace("Z", "+00:00"))
    except Exception:
        start_dt = datetime.now(timezone.utc)
    from datetime import timedelta as _td
    docs = []
    for tmpl in DEFAULT_ONBOARDING_TEMPLATE:
        due = (start_dt + _td(days=tmpl["due_offset_days"])).isoformat()
        docs.append({
            "id": _id(),
            "prospect_id": pid,
            "title": tmpl["title"],
            "due_offset_days": tmpl["due_offset_days"],
            "due_date": due,
            "completed": False,
            "completed_at": None,
            "completed_by_id": None,
            "completed_by_name": None,
            "notes": "",
            "created_at": _now(),
        })
    if docs:
        await db.onboarding.insert_many(docs)
    await _activity(
        "onboarding_init",
        f"Onboarding-checklista skapad för {prospect['name']} ({len(docs)} steg)",
        actor=user, prospect_id=pid, prospect_name=prospect["name"],
    )
    return await list_onboarding(pid, user)


@api.post("/prospects/{pid}/onboarding")
async def add_onboarding_item(pid: str, body: OnboardingItemCreate,
                              user: dict = Depends(current_user)):
    prospect = await db.prospects.find_one({"id": pid}, {"_id": 0})
    if not prospect:
        raise HTTPException(404, "Prospekt hittades inte")
    from datetime import timedelta as _td
    start_date = prospect.get("start_date") or _now()
    try:
        start_dt = datetime.fromisoformat(start_date.replace("Z", "+00:00"))
    except Exception:
        start_dt = datetime.now(timezone.utc)
    doc = {
        "id": _id(),
        "prospect_id": pid,
        "title": body.title,
        "due_offset_days": body.due_offset_days,
        "due_date": (start_dt + _td(days=body.due_offset_days)).isoformat(),
        "completed": False,
        "completed_at": None,
        "completed_by_id": None,
        "completed_by_name": None,
        "notes": body.notes,
        "created_at": _now(),
    }
    await db.onboarding.insert_one(doc)
    return _strip_id(doc)


@api.patch("/onboarding/{item_id}")
async def update_onboarding(item_id: str, body: OnboardingItemUpdate,
                            user: dict = Depends(current_user)):
    existing = await db.onboarding.find_one({"id": item_id}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Onboarding-steg hittades inte")
    updates: dict[str, Any] = {}
    if body.title is not None:
        updates["title"] = body.title
    if body.notes is not None:
        updates["notes"] = body.notes
    if body.due_offset_days is not None:
        updates["due_offset_days"] = body.due_offset_days
    if body.completed is not None:
        updates["completed"] = body.completed
        updates["completed_at"] = _now() if body.completed else None
        updates["completed_by_id"] = user["id"] if body.completed else None
        updates["completed_by_name"] = user["name"] if body.completed else None
    if not updates:
        raise HTTPException(400, "Inget att uppdatera")
    await db.onboarding.update_one({"id": item_id}, {"$set": updates})
    it = await db.onboarding.find_one({"id": item_id}, {"_id": 0})
    return _strip_id(it)


@api.delete("/onboarding/{item_id}")
async def delete_onboarding(item_id: str, user: dict = Depends(current_user)):
    res = await db.onboarding.delete_one({"id": item_id})
    if not res.deleted_count:
        raise HTTPException(404, "Steg hittades inte")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Activity log
# ---------------------------------------------------------------------------
@api.get("/activity")
async def get_activity(limit: int = Query(50, le=500)):
    items = [_strip_id(a) async for a in
             db.activity.find({}, {"_id": 0}).sort("created_at", -1).limit(limit)]
    return {"items": items, "total": len(items)}


# ---------------------------------------------------------------------------
# Goals
# ---------------------------------------------------------------------------
@api.get("/goals")
async def list_goals():
    items = [_strip_id(g) async for g in db.goals.find({}, {"_id": 0})]
    return {"items": items}


@api.post("/goals")
async def create_goal(body: GoalIn):
    doc = body.model_dump()
    doc["id"] = _id()
    doc["created_at"] = _now()
    await db.goals.insert_one(doc)
    return _strip_id(doc)


@api.patch("/goals/{gid}")
async def update_goal(gid: str, body: GoalUpdate):
    updates = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if not updates:
        raise HTTPException(400, "Inget att uppdatera")
    await db.goals.update_one({"id": gid}, {"$set": updates})
    g = await db.goals.find_one({"id": gid}, {"_id": 0})
    if not g:
        raise HTTPException(404, "Mål hittades inte")
    return _strip_id(g)


@api.delete("/goals/{gid}")
async def delete_goal(gid: str):
    res = await db.goals.delete_one({"id": gid})
    if not res.deleted_count:
        raise HTTPException(404, "Mål hittades inte")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Geo (map + whitespots)
# ---------------------------------------------------------------------------
@api.get("/geo/municipalities")
async def geo_municipalities():
    cities_with_offices = set()
    async for o in db.offices.find({}, {"_id": 0, "city": 1, "name": 1}):
        for v in (o.get("city"), o.get("name")):
            if v:
                cities_with_offices.add(v.strip().lower())
                # Also add components split on "/" and "-" (e.g. "Nyköping/Oxelösund")
                for part in re.split(r"[/\-]", v):
                    p = part.strip().lower()
                    if p:
                        cities_with_offices.add(p)

    competitor_pool = [
        "Fastighetsbyrån", "Svensk Fastighetsförmedling",
        "Länsförsäkringar Fastighetsförmedling", "HusmanHagberg", "ERA", "Mäklarhuset",
    ]
    import random as _r
    _r.seed(1)
    out = []
    for m in MUNICIPALITIES:
        has = m["name"].lower() in cities_with_offices
        # Deterministic competitor presence based on population
        n_comp = min(5, max(1, m["population"] // 30000))
        comps = competitor_pool[:n_comp]
        out.append({
            **m,
            "has_skandia": has,
            "competitors": comps,
            "competitor_count": len(comps),
        })
    return {"items": out, "total": len(out)}


@api.get("/geo/whitespots")
async def whitespots(min_population: int = 25000, limit: int = 30):
    geo = await geo_municipalities()
    items = [m for m in geo["items"]
             if not m["has_skandia"] and m["population"] >= min_population]
    # Score: population * 0.6 + transactions * 0.4 - competitor_count * 5000
    for m in items:
        m["opportunity_score"] = round(
            m["population"] * 0.0001 + m["transactions"] * 0.001 - m["competitor_count"] * 0.5, 2
        )
    items.sort(key=lambda m: m["opportunity_score"], reverse=True)
    return {"items": items[:limit], "total": len(items)}


# ---------------------------------------------------------------------------
# Lead discovery — curated links + AI strategy for white-spot cities
# ---------------------------------------------------------------------------
def _city_meta(city: str) -> dict:
    for m in MUNICIPALITIES:
        if m["name"].lower() == city.lower():
            return m
    return {"name": city, "region": "", "population": 0, "transactions": 0,
            "lat": 0, "lng": 0}


@api.get("/discovery/{city}")
async def discovery_links(city: str, user: dict = Depends(current_user)):
    """Curated lead-discovery links for a city (no scraping involved)."""
    from urllib.parse import quote
    safe = quote(city)
    meta = _city_meta(city)
    return {
        "city": city,
        "meta": meta,
        "groups": [
            {
                "label": "Konkurrenters mäklare i orten",
                "icon": "Buildings",
                "items": [
                    {"label": "Fastighetsbyrån", "url": f"https://www.fastighetsbyran.com/sv/sok/?ort={safe}"},
                    {"label": "Svensk Fastighetsförmedling", "url": f"https://www.svenskfast.se/maklare/?ort={safe}"},
                    {"label": "Länsförsäkringar Fastighetsförmedling", "url": f"https://www.lansfast.se/maklare/?ort={safe}"},
                    {"label": "HusmanHagberg", "url": f"https://www.husmanhagberg.se/maklare/?ort={safe}"},
                    {"label": "ERA Sverige", "url": f"https://www.era.se/sok/?ort={safe}"},
                    {"label": "Bjurfors", "url": f"https://www.bjurfors.se/maklare?ort={safe}"},
                    {"label": "Mäklarhuset", "url": f"https://www.maklarhuset.se/maklare?ort={safe}"},
                    {"label": "Notar", "url": f"https://notar.se/maklare/?ort={safe}"},
                ],
            },
            {
                "label": "Branschregister & marknadsdata",
                "icon": "Database",
                "items": [
                    {"label": "Mäklarsamfundets register", "url": f"https://www.maklarsamfundet.se/hitta-maklare?ort={safe}"},
                    {"label": "Hemnet — mäklare i orten", "url": f"https://www.hemnet.se/maklare?location={safe}"},
                    {"label": "Booli — sålt-statistik", "url": f"https://www.booli.se/slutpriser/{safe.lower()}"},
                    {"label": "Allabolag — mäklarföretag", "url": f"https://www.allabolag.se/what/m%C3%A4klare+{safe}"},
                ],
            },
            {
                "label": "Sociala medier & sökmotorer",
                "icon": "MagnifyingGlass",
                "items": [
                    {"label": "LinkedIn-mäklare (Google)", "url": f"https://www.google.com/search?q=site%3Alinkedin.com%2Fin+%22fastighetsm%C3%A4klare%22+%22{safe}%22"},
                    {"label": "LinkedIn-kontorschefer (Google)", "url": f"https://www.google.com/search?q=site%3Alinkedin.com%2Fin+%22kontorschef%22+%22fastighetsm%C3%A4klare%22+%22{safe}%22"},
                    {"label": "Google Maps — mäklarkontor", "url": f"https://www.google.com/maps/search/fastighetsm%C3%A4klare+{safe}"},
                    {"label": "Google News — mäklare i orten", "url": f"https://www.google.com/search?q=fastighetsm%C3%A4klare+{safe}&tbm=nws"},
                ],
            },
        ],
    }


@api.post("/discovery/{city}/ai-strategy")
async def discovery_ai_strategy(city: str, user: dict = Depends(current_user)):
    """Generate AI-powered sourcing strategy for a city."""
    meta = _city_meta(city)
    # Reuse competitor list logic from geo_municipalities
    competitors = []
    n_comp = min(5, max(1, meta.get("population", 0) // 30000)) if meta.get("population") else 3
    pool = ["Fastighetsbyrån", "Svensk Fastighetsförmedling",
            "Länsförsäkringar Fastighetsförmedling", "HusmanHagberg", "ERA", "Mäklarhuset"]
    competitors = pool[:n_comp]
    try:
        strategy = await generate_discovery_strategy(
            city=city,
            region=meta.get("region", ""),
            population=meta.get("population", 0),
            transactions=meta.get("transactions", 0),
            competitors=competitors,
        )
    except Exception as e:
        logger.exception("Discovery AI failed")
        raise HTTPException(500, f"AI-fel: {e}")
    await _activity(
        "ai_discovery",
        f"AI-strategi genererad för {city}",
        actor=user,
    )
    return {"city": city, "strategy": strategy, "competitors": competitors, "meta": meta}


# ---------------------------------------------------------------------------
# Scrape
# ---------------------------------------------------------------------------
@api.get("/scrape/status")
async def scrape_status():
    last = await db.scrapes.find_one({}, {"_id": 0}, sort=[("started_at", -1)])
    return {"last": last}


@api.post("/scrape/run")
async def scrape_run(limit: int = Query(5, ge=1, le=200), user: dict = Depends(current_user)):
    result = await scrape_offices(limit=limit, db=db)
    # Persist run metadata (NOT the full office payloads to keep doc small)
    record = {
        "id": _id(),
        "status": result["status"],
        "started_at": result["started_at"],
        "finished_at": result["finished_at"],
        "offices_found": result["offices_found"],
        "offices_parsed": result["offices_parsed"],
        "brokers_parsed": result.get("brokers_parsed", 0),
        "errors": result["errors"],
        "limit": limit,
        "mode": "preview",
    }
    await db.scrapes.insert_one(record)

    # Upsert scraped offices into a side collection so we don't overwrite seed
    # data but we surface what was discovered live.
    if result["offices"]:
        for o in result["offices"]:
            await db.scraped_offices.update_one(
                {"url": o["url"]},
                {"$set": {**o, "scraped_at": _now()}},
                upsert=True,
            )

    await _activity("scrape", f"Scrape körd — {result['offices_parsed']}/{result['offices_found']} kontor hämtade",
                    actor=user)

    return {**result, "record_id": record["id"]}


@api.post("/scrape/sync")
async def scrape_sync(user: dict = Depends(current_user)):
    """Run a full scrape and REPLACE the offices + brokers + scraped_offices collections.

    Use this to bring the dashboard's primary data fully in sync with the live site.
    Existing prospects, goals, activity log are untouched.
    """
    result = await scrape_offices(limit=None, db=db)
    record = {
        "id": _id(),
        "status": result["status"],
        "started_at": result["started_at"],
        "finished_at": result["finished_at"],
        "offices_found": result["offices_found"],
        "offices_parsed": result["offices_parsed"],
        "brokers_parsed": result.get("brokers_parsed", 0),
        "errors": result["errors"],
        "limit": None,
        "mode": "sync",
    }
    await db.scrapes.insert_one(record)

    if result["status"] != "ok" or not result["offices"]:
        await _activity(
            "scrape",
            f"Full sync misslyckades — status={result['status']}, fel: {result['errors']}",
            actor=user,
        )
        return {**result, "record_id": record["id"], "replaced": False}

    # Build documents
    office_docs = []
    broker_docs = []
    discovered_docs = []
    for p in result["offices"]:
        od = to_office_doc(p)
        office_docs.append(od)
        broker_docs.extend(to_broker_docs(p, od))
        discovered_docs.append({**p, "scraped_at": _now()})

    # Replace primary collections atomically (best-effort sequential)
    await db.offices.delete_many({})
    if office_docs:
        await db.offices.insert_many(office_docs)
    await db.brokers.delete_many({})
    if broker_docs:
        await db.brokers.insert_many(broker_docs)
    # Remove old seed listings (since brokers are replaced, their listings are stale)
    await db.listings.delete_many({})
    # Refresh discovered side collection
    await db.scraped_offices.delete_many({})
    if discovered_docs:
        await db.scraped_offices.insert_many(discovered_docs)

    await _activity(
        "scrape",
        f"Full sync klar — {len(office_docs)} kontor, {len(broker_docs)} mäklare ersatte tidigare data",
        actor=user,
    )

    return {
        **result,
        "record_id": record["id"],
        "replaced": True,
        "offices_written": len(office_docs),
        "brokers_written": len(broker_docs),
    }


@api.get("/scrape/discovered")
async def scrape_discovered():
    items = [_strip_id(o) async for o in db.scraped_offices.find({}, {"_id": 0}).limit(200)]
    return {"items": items, "total": len(items)}


# ---------------------------------------------------------------------------
# AI research brief
# ---------------------------------------------------------------------------
@api.post("/ai/research-brief")
async def ai_brief(body: ResearchRequest, user: dict = Depends(current_user)):
    try:
        brief = await generate_brief(
            name=body.name,
            city=body.city,
            agency=body.current_agency,
            notes=body.notes,
        )
    except Exception as e:
        logger.exception("AI brief failed")
        raise HTTPException(500, f"AI-fel: {e}")

    if body.prospect_id:
        await db.prospects.update_one(
            {"id": body.prospect_id},
            {"$set": {"ai_brief": brief, "ai_brief_at": _now()}},
        )
        await _activity("ai_brief", f"AI-research genererad för {body.name}",
                        actor=user, prospect_id=body.prospect_id, prospect_name=body.name)
    return {"brief": brief}


# ---------------------------------------------------------------------------
# Email reminders
# ---------------------------------------------------------------------------
@api.post("/reminders/send")
async def send_reminder_for(body: SendReminderRequest, user: dict = Depends(current_user)):
    p = await db.prospects.find_one({"id": body.prospect_id}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Prospekt hittades inte")
    recipient = body.recipient or os.environ.get("REMINDER_RECIPIENT", "")
    if not recipient:
        return {"status": "skipped",
                "message": "Ingen mottagare angiven (sätt REMINDER_RECIPIENT i .env eller skicka 'recipient')."}

    html = build_reminder_html(
        prospect_name=p["name"],
        next_step=p.get("next_step", ""),
        next_step_date=p.get("next_step_date", "")[:10] if p.get("next_step_date") else "",
        city=p.get("city", ""),
        current_agency=p.get("current_agency", ""),
        notes=p.get("notes", ""),
    )
    res = await send_reminder(recipient, f"Påminnelse: {p['name']} – {p.get('next_step', 'Uppföljning')}", html)
    await _activity("reminder", f"Påminnelse {res['status']} för {p['name']}",
                    actor=user, prospect_id=p["id"], prospect_name=p["name"])
    return res


@api.get("/reminders/due")
async def reminders_due(days_ahead: int = 7):
    """Return prospects with next_step_date within the next N days."""
    from datetime import timedelta
    now = datetime.now(timezone.utc)
    cutoff = (now + timedelta(days=days_ahead)).isoformat()
    items = []
    async for p in db.prospects.find(
        {"next_step_date": {"$exists": True, "$ne": None, "$lte": cutoff}},
        {"_id": 0},
    ).sort("next_step_date", 1):
        items.append(_strip_id(p))
    return {"items": items, "total": len(items), "cutoff": cutoff}


# ---------------------------------------------------------------------------
# CSV export
# ---------------------------------------------------------------------------
def _csv_response(rows: list[dict], fields: list[str], filename: str) -> StreamingResponse:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    for r in rows:
        writer.writerow({k: r.get(k, "") for k in fields})
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@api.get("/export/offices.csv")
async def export_offices_csv(user: dict = Depends(current_user)):
    items = [_strip_id(o) async for o in db.offices.find({}, {"_id": 0}).sort("name", 1)]
    return _csv_response(
        items,
        ["name", "city", "region", "address", "phone", "email", "manager", "website"],
        "skandia-kontor.csv",
    )


@api.get("/export/brokers.csv")
async def export_brokers_csv(user: dict = Depends(current_user)):
    items = [_strip_id(b) async for b in db.brokers.find({}, {"_id": 0}).sort("name", 1)]
    return _csv_response(
        items,
        ["name", "title", "phone", "email", "office_name", "city", "active_listings",
         "ytd_sales", "profile_url"],
        "skandia-maklare.csv",
    )


@api.get("/export/prospects.csv")
async def export_prospects_csv(user: dict = Depends(current_user)):
    items = [_strip_id(p) async for p in db.prospects.find({}, {"_id": 0}).sort("status", 1)]
    return _csv_response(
        items,
        ["name", "type", "status", "current_agency", "city", "region", "phone", "email",
         "linkedin", "source", "referred_by", "owner_name",
         "next_step", "next_step_date", "notes",
         "is_lost", "lost_to_agency", "lost_reason", "lost_at"],
        "skandia-prospekt.csv",
    )


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@api_public.get("/")
async def root():
    return {"app": "skandia-etablering", "ok": True, "as_of": _now()}


# ---------------------------------------------------------------------------
# Auth endpoints (public)
# ---------------------------------------------------------------------------
@api_public.post("/auth/login")
async def login(body: LoginRequest, request: Request, response: Response):
    # Behind a reverse proxy (K8s ingress), request.client.host is the proxy.
    # Prefer the first hop in X-Forwarded-For so brute-force keying works.
    fwd = request.headers.get("x-forwarded-for", "")
    ip = (fwd.split(",")[0].strip() if fwd
          else (request.client.host if request.client else "unknown"))
    email = body.email.lower().strip()

    if await is_locked_out(db, ip, email):
        raise HTTPException(429, "För många misslyckade försök — försök igen om 15 min")

    user = await db.users.find_one({"email": email})
    if not user or not verify_password(body.password, user.get("password_hash", "")):
        await record_failed_attempt(db, ip, email)
        raise HTTPException(401, "Fel e-post eller lösenord")

    await clear_attempts(db, ip, email)
    access = create_access_token(user["id"], user["email"])
    refresh = create_refresh_token(user["id"])
    set_auth_cookies(response, access, refresh)
    safe = {k: v for k, v in user.items() if k not in ("_id", "password_hash")}
    return {"user": safe, "access_token": access}


@api_public.post("/auth/logout")
async def logout(response: Response):
    clear_auth_cookies(response)
    return {"ok": True}


@api_public.post("/auth/refresh")
async def refresh_token(request: Request, response: Response):
    import jwt as _jwt
    tok = request.cookies.get("refresh_token")
    if not tok:
        raise HTTPException(401, "Saknar refresh-token")
    try:
        payload = decode_token(tok, "refresh")
    except _jwt.ExpiredSignatureError:
        raise HTTPException(401, "Refresh-token utgången")
    except _jwt.InvalidTokenError:
        raise HTTPException(401, "Ogiltig refresh-token")
    user = await db.users.find_one({"id": payload["sub"]}, {"_id": 0, "password_hash": 0})
    if not user:
        raise HTTPException(401, "Användare saknas")
    new_access = create_access_token(user["id"], user["email"])
    new_refresh = create_refresh_token(user["id"])
    set_auth_cookies(response, new_access, new_refresh)
    return {"user": user, "access_token": new_access}


@api.get("/auth/me")
async def me(user: dict = Depends(current_user)):
    return user


# ---------------------------------------------------------------------------
# Users (team management) — read for all authed, write for admin
# ---------------------------------------------------------------------------
@api.get("/users")
async def list_users(user: dict = Depends(current_user)):
    items = []
    async for u in db.users.find({}, {"_id": 0, "password_hash": 0}).sort("name", 1):
        items.append(u)
    return {"items": items, "total": len(items)}


@api.post("/users")
async def create_user(body: UserCreate, admin: dict = Depends(admin_only)):
    email = body.email.lower().strip()
    if await db.users.find_one({"email": email}):
        raise HTTPException(409, "E-post används redan")
    if body.role not in ("admin", "member"):
        raise HTTPException(400, "Ogiltig roll")
    doc = {
        "id": _id(),
        "email": email,
        "name": body.name.strip(),
        "role": body.role,
        "password_hash": hash_password(body.password),
        "created_at": _now(),
        "created_by": admin["id"],
    }
    await db.users.insert_one(doc)
    await _activity("user_created", f"Användare skapad: {doc['name']} ({doc['role']})", actor=admin)
    safe = {k: v for k, v in doc.items() if k not in ("password_hash", "_id")}
    return safe


@api.patch("/users/{uid}")
async def update_user(uid: str, body: UserUpdate, admin: dict = Depends(admin_only)):
    existing = await db.users.find_one({"id": uid})
    if not existing:
        raise HTTPException(404, "Användare hittades inte")
    updates: dict[str, Any] = {}
    if body.name is not None:
        updates["name"] = body.name.strip()
    if body.role is not None:
        if body.role not in ("admin", "member"):
            raise HTTPException(400, "Ogiltig roll")
        updates["role"] = body.role
    if body.password:
        updates["password_hash"] = hash_password(body.password)
    if not updates:
        raise HTTPException(400, "Inget att uppdatera")
    await db.users.update_one({"id": uid}, {"$set": updates})
    await _activity("user_updated", f"Användare uppdaterad: {existing['name']}", actor=admin)
    u = await db.users.find_one({"id": uid}, {"_id": 0, "password_hash": 0})
    return u


@api.delete("/users/{uid}")
async def delete_user(uid: str, admin: dict = Depends(admin_only)):
    if uid == admin["id"]:
        raise HTTPException(400, "Du kan inte ta bort dig själv")
    existing = await db.users.find_one({"id": uid})
    if not existing:
        raise HTTPException(404, "Användare hittades inte")
    await db.users.delete_one({"id": uid})
    # Unassign prospects owned by this user
    await db.prospects.update_many(
        {"owner_id": uid},
        {"$set": {"owner_id": None, "owner_name": ""}},
    )
    await _activity("user_deleted", f"Användare borttagen: {existing['name']}", actor=admin)
    return {"ok": True}


# ---------------------------------------------------------------------------
# App wiring
# ---------------------------------------------------------------------------
app.include_router(api_public)
app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=[
        os.environ.get("FRONTEND_URL", "http://localhost:3000"),
        "http://localhost:3000",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown():
    client.close()
```


## `backend/auth.py`

```python
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
```


## `backend/ai_service.py`

```python
"""AI research brief generator for värvningsprospekt.

Uses Emergent LLM Key + Claude Sonnet 4.5 via emergentintegrations.
"""
from __future__ import annotations
import os
import logging
import uuid

from emergentintegrations.llm.chat import LlmChat, UserMessage

logger = logging.getLogger(__name__)


SYSTEM_PROMPT = """Du är en strategisk research-analytiker som hjälper en etableringschef på Skandiamäklarna att förbereda värvningssamtal med fastighetsmäklare i Sverige.

Du genererar en kort, faktabaserad och konkret research-brief på SVENSKA i strikt Markdown-format med följande sektioner. Var direkt och affärsmässig — nollfluff.

**Format (strikt):**

### Sammanfattning
2-3 meningar om vem detta sannolikt är (utifrån namn, ort och kedja). Var ärlig med osäkerhet.

### Värvningsvinkel
3-4 punkter — varför skulle denna mäklare passa Skandiamäklarna? Vad är typiska smärtpunkter hos en mäklare på {agency} i {city}?

### Marknadsläge i {city}
2-3 punkter om lokala bostadsmarknaden, kedjornas närvaro och möjligheter.

### Öppningsfrågor
4-5 konkreta samtalsfrågor som etableringschefen kan ställa i första kontakten.

### Källor att kontrollera
Lista 3-5 publika källor (Hemnet, LinkedIn, Mäklarsamfundet, Allabolag, lokal press) som etableringschefen själv bör verifiera. Var tydlig: detta är hypoteser, inte fakta.

Använd aldrig påhittade siffror som om de vore verifierade. När du gissar, säg "uppskattning" eller "sannolikt"."""


DISCOVERY_PROMPT = """Du är en sourcing-strateg som hjälper en etableringschef på Skandiamäklarna att hitta mäklare att värva i en stad där Skandia INTE har kontor. Generera en konkret aktionsplan på SVENSKA i strikt Markdown.

**Stad:** {city}
**Region:** {region}
**Befolkning:** {population}
**Uppskattade bostadstransaktioner/år:** {transactions}
**Konkurrenter på plats:** {competitors}

Format (strikt):

### Marknadsbild i {city}
2-3 punkter om vad som karaktäriserar mäklarmarknaden här — storlek, dominerande aktörer, om det är lokala vs rikstäckande kedjor som styr.

### Kandidat-profiler att leta efter
4 distinkta arketyper av mäklare som sannolikt skulle byta till Skandia just nu. För varje: 1 mening om profilen + 1 mening om varför de skulle vilja byta. Var konkret (t.ex. "Kontorschef på lokal aktör som vill ta steget mot rikstäckande varumärke").

### Konkreta sökstrategier
5 specifika åtgärder etableringschefen kan göra IDAG för att hitta namn. Var operativ: ge exakta sökfraser, register att kolla, telefonbok-tips, branschrelationer att utnyttja.

### Första kontakt-pitch (specifik för {city})
3-4 punkter om vad som funkar i värvningssamtal *just här* — vad är Skandias edge mot konkurrenterna i denna stad?

### Top 3 prioriteringar
Numrerad lista. Vad bör göras först, denna vecka, för att etablera närvaro i {city}?

Var direkt, nollfluff. Använd "uppskattning" eller "sannolikt" när du gissar."""


async def generate_brief(name: str, city: str, agency: str, notes: str = "") -> str:
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise RuntimeError("EMERGENT_LLM_KEY saknas i .env")

    chat = LlmChat(
        api_key=api_key,
        session_id=f"brief-{uuid.uuid4()}",
        system_message=SYSTEM_PROMPT.format(agency=agency or "okänd kedja", city=city or "okänd ort"),
    ).with_model("anthropic", "claude-sonnet-4-6")

    user_text = (
        f"Generera research-brief för värvningsprospekt:\n\n"
        f"- Namn: {name}\n"
        f"- Ort: {city or 'okänd'}\n"
        f"- Nuvarande kedja: {agency or 'okänd'}\n"
        f"- Mina anteckningar: {notes or '(inga)'}\n\n"
        f"Skriv på svenska enligt det fasta formatet."
    )
    response = await chat.send_message(UserMessage(text=user_text))
    return response if isinstance(response, str) else str(response)


async def generate_discovery_strategy(
    city: str,
    region: str = "",
    population: int = 0,
    transactions: int = 0,
    competitors: list[str] | None = None,
) -> str:
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise RuntimeError("EMERGENT_LLM_KEY saknas i .env")

    comps_str = ", ".join(competitors) if competitors else "okänt"
    chat = LlmChat(
        api_key=api_key,
        session_id=f"discovery-{uuid.uuid4()}",
        system_message=DISCOVERY_PROMPT.format(
            city=city or "okänd ort",
            region=region or "okänd region",
            population=f"{population:,}".replace(",", " ") if population else "okänd",
            transactions=f"{transactions:,}".replace(",", " ") if transactions else "okänd",
            competitors=comps_str,
        ),
    ).with_model("anthropic", "claude-sonnet-4-6")

    user_text = (
        f"Skapa en lead-discovery-aktionsplan för {city}. "
        f"Skandiamäklarna har inget kontor här idag. "
        f"Använd det fasta formatet i system-prompten."
    )
    response = await chat.send_message(UserMessage(text=user_text))
    return response if isinstance(response, str) else str(response)
```


## `backend/scraper.py`

```python
"""Live scraper for skandiamaklarna.se.

The site's structure (verified 2026):
- Index page: /kontor/   → contains <a href="/hitta-maklare/<slug>/"> for every office (92 total)
- Office page: /hitta-maklare/<slug>/
    - JSON-LD type "RealEstateAgent" with name, address {streetAddress, postalCode, addressLocality}, email, telephone
    - Brokers are H3 names under "Våra mäklare i ..." section; each H3's parent <div> contains
      tel:/mailto: anchors + a role <p>. Profile photos at /contentassets/.../profile-photo-XXX.png
      appear in document order matching the H3 list.

Geocoding: we cache lat/lng per city in a Mongo collection (db.geocache) via Nominatim.
"""
from __future__ import annotations
import asyncio
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote

import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

BASE_URL = "https://www.skandiamaklarna.se"
INDEX_URL = f"{BASE_URL}/kontor/"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

# Quick built-in coord lookup for the bigger Swedish cities so we don't hit
# Nominatim for them on every sync.
BUILTIN_COORDS: dict[str, tuple[float, float]] = {
    "stockholm": (59.3293, 18.0686),
    "göteborg": (57.7089, 11.9746),
    "malmö": (55.6049, 13.0038),
    "uppsala": (59.8586, 17.6389),
    "linköping": (58.4108, 15.6214),
    "västerås": (59.6099, 16.5448),
    "örebro": (59.2741, 15.2066),
    "helsingborg": (56.0465, 12.6945),
    "norrköping": (58.5877, 16.1924),
    "jönköping": (57.7826, 14.1618),
    "lund": (55.7047, 13.191),
    "umeå": (63.8258, 20.263),
    "gävle": (60.6749, 17.1413),
    "borås": (57.721, 12.9401),
    "eskilstuna": (59.3711, 16.5092),
    "södertälje": (59.1955, 17.6253),
    "karlstad": (59.3793, 13.5036),
    "täby": (59.4439, 18.0686),
    "växjö": (56.8777, 14.8094),
    "halmstad": (56.6745, 12.8578),
    "sundsvall": (62.3908, 17.3069),
    "luleå": (65.5848, 22.1547),
    "trollhättan": (58.2837, 12.2886),
    "östersund": (63.1792, 14.6357),
    "kalmar": (56.6634, 16.3568),
    "falun": (60.6066, 15.6355),
    "skellefteå": (64.7507, 20.9528),
    "kristianstad": (56.0294, 14.1567),
    "karlskrona": (56.1612, 15.5869),
    "skövde": (58.3911, 13.8451),
    "uddevalla": (58.3498, 11.9416),
    "varberg": (57.1057, 12.2502),
    "lidköping": (58.5076, 13.1576),
    "motala": (58.5403, 15.0438),
    "trelleborg": (55.3753, 13.1574),
    "sandviken": (60.6173, 16.7763),
    "härnösand": (62.6322, 17.9379),
    "vänersborg": (58.3811, 12.3239),
    "borlänge": (60.4858, 15.4371),
    "nyköping": (58.7531, 17.0086),
    "hässleholm": (56.1591, 13.766),
    "landskrona": (55.8708, 12.8301),
    "ängelholm": (56.2428, 12.8624),
    "kungälv": (57.8702, 11.9745),
    "piteå": (65.317, 21.4794),
    "lerum": (57.77, 12.2685),
    "sigtuna": (59.6175, 17.7203),
    "värnamo": (57.1856, 14.0444),
    "strängnäs": (59.3779, 17.0337),
    "enköping": (59.6363, 17.0773),
    "kungsbacka": (57.4878, 12.0759),
    "mölndal": (57.6554, 12.0138),
    "partille": (57.7395, 12.1066),
    "lidingö": (59.3645, 18.1326),
    "nacka": (59.311, 18.164),
    "sollentuna": (59.428, 17.951),
    "solna": (59.3611, 18.0008),
    "falkenberg": (56.9054, 12.4912),
    "bromma": (59.3361, 17.9419),
    "visby": (57.6348, 18.2948),
    "ale": (57.95, 12.05),
    "botkyrka": (59.2, 17.83),
    "danderyd": (59.4, 18.04),
    "eksjö": (57.6667, 14.9667),
    "enskede": (59.28, 18.08),
    "eslöv": (55.84, 13.30),
    "gnesta": (59.05, 17.30),
    "haninge": (59.17, 18.14),
    "hjo": (58.30, 14.28),
    "huddinge": (59.24, 17.99),
    "hägersten": (59.30, 17.97),
    "höllviken": (55.42, 12.97),
    "höör": (55.93, 13.55),
    "järfälla": (59.42, 17.83),
    "katrineholm": (58.99, 16.21),
    "klippan": (56.13, 13.13),
    "kävlinge": (55.79, 13.11),
    "lomma": (55.67, 13.07),
    "mariestad": (58.71, 13.82),
    "mjölby": (58.32, 15.13),
    "norrtälje": (59.76, 18.70),
    "oxelösund": (58.67, 17.10),
    "sala": (59.92, 16.60),
    "saltsjöbaden": (59.28, 18.30),
    "sjöbo": (55.63, 13.71),
    "småland": (57.00, 14.50),
    "spånga": (59.38, 17.90),
    "staffanstorp": (55.64, 13.21),
    "stenungsund": (58.07, 11.82),
    "kungsholmen": (59.33, 18.03),
    "skärgård": (59.30, 18.50),
    "södermalm": (59.31, 18.07),
    "vasastan": (59.34, 18.04),
    "östermalm": (59.34, 18.09),
    "mariefred": (59.27, 17.22),
    "sundbyberg": (59.36, 17.97),
    "timrå": (62.49, 17.32),
    "svedala": (55.51, 13.24),
    "bara": (55.59, 13.18),
    "sälen": (61.16, 13.27),
    "söderhamn": (61.30, 17.06),
    "hudiksvall": (61.73, 17.10),
    "bollnäs": (61.35, 16.40),
    "trosa": (58.90, 17.55),
    "tyresö": (59.24, 18.30),
    "älta": (59.27, 18.18),
    "upplands bro": (59.51, 17.65),
    "upplands väsby": (59.52, 17.92),
    "vaxholm": (59.40, 18.35),
    "vemdalen": (62.43, 13.85),
    "funäsdalen": (62.55, 12.55),
    "vällingby": (59.36, 17.87),
    "hässelby": (59.37, 17.83),
    "värmdö": (59.32, 18.50),
    "ystad": (55.43, 13.83),
    "åre": (63.40, 13.08),
    "årsta": (59.30, 18.04),
    "stureby": (59.28, 18.07),
    "östberga": (59.28, 18.05),
    "älvsjö": (59.28, 18.01),
    "bandhagen": (59.27, 18.06),
    "fruängen": (59.29, 17.97),
    "örnsköldsvik": (63.29, 18.72),
    "österåker": (59.50, 18.30),
    "åkersberga": (59.48, 18.30),
}


def _id() -> str:
    return str(uuid.uuid4())


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm_city(c: str) -> str:
    return (c or "").strip().lower()


async def _fetch(client: httpx.AsyncClient, url: str) -> Optional[str]:
    try:
        r = await client.get(url, timeout=20.0)
        if r.status_code == 200:
            return r.text
        logger.warning(f"Non-200 from {url}: {r.status_code}")
    except Exception as e:
        logger.warning(f"Fetch failed {url}: {e}")
    return None


def _parse_office_links(html: str) -> list[str]:
    soup = BeautifulSoup(html, "lxml")
    seen, urls = set(), []
    for a in soup.find_all("a", href=re.compile(r"^/hitta-maklare/[a-z0-9öäåü\-]+/$")):
        href = a["href"]
        if href in seen or href == "/hitta-maklare/":
            continue
        seen.add(href)
        urls.append(BASE_URL + href)
    return urls


def _parse_office_page(url: str, html: str) -> Optional[dict]:
    soup = BeautifulSoup(html, "lxml")

    # Slug fallback from URL: /hitta-maklare/<slug>/
    slug = ""
    m = re.search(r"/hitta-maklare/([^/]+)/", url)
    if m:
        slug = m.group(1)

    # 1. Pull JSON-LD RealEstateAgent
    name = addr_street = addr_city = addr_postal = office_email = office_phone = ""
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.string or "{}")
        except Exception:
            continue
        items = data if isinstance(data, list) else [data]
        for it in items:
            if isinstance(it, dict) and it.get("@type") == "RealEstateAgent":
                name = it.get("name") or ""
                a = it.get("address") or {}
                addr_street = a.get("streetAddress") or ""
                addr_city = a.get("addressLocality") or ""
                addr_postal = a.get("postalCode") or ""
                office_email = it.get("email") or ""
                office_phone = it.get("telephone") or ""
                break
        if name:
            break

    if not name:
        h1 = soup.find("h1")
        if h1:
            name = re.sub(r"^Mäklare\s+", "", h1.get_text(strip=True))
    if not name and slug:
        name = slug.replace("-", " ").title()

    # Fallback city from H1 / slug
    if not addr_city:
        h1 = soup.find("h1")
        if h1:
            t = re.sub(r"^Mäklare\s+", "", h1.get_text(strip=True))
            addr_city = t.split("/")[0].strip()
        if not addr_city and slug:
            addr_city = slug.split("-")[0].replace("oxelosund", "").title()

    # Try to scan body for "XXX XX City" pattern if street still missing
    if not addr_street:
        body_text = soup.get_text(" ", strip=True)
        sm = re.search(r"([A-ZÅÄÖ][\wåäöÅÄÖ\.\- ]{1,40}\s+\d{1,3}[A-Za-z]?),?\s*(\d{3}\s?\d{2})\s+([A-ZÅÄÖ][\wåäöÅÄÖ\- ]+)", body_text)
        if sm:
            addr_street = sm.group(1).strip()
            if not addr_postal:
                addr_postal = sm.group(2).strip()
            if not addr_city:
                addr_city = sm.group(3).strip().split(" ")[0]

    full_address = ", ".join(
        p for p in [addr_street, (addr_postal + " " + addr_city).strip()] if p.strip()
    )

    # 2. Collect every H3 that has a nearby mailto: anchor — per-broker filters
    # below ensure section headers and bogus H3s get rejected.
    candidate_h3s = [
        h for h in soup.find_all("h3")
        if h.find_next("a", href=re.compile(r"^mailto:"))
    ]

    # Profile-photo images in document order
    profile_imgs = [
        (img.get("src") or "")
        for img in soup.find_all("img")
        if "profile-photo" in (img.get("src") or "")
    ]

    brokers: list[dict] = []
    bad_words = ["våra", "öppettider", "värdera", "sälja", "köpa", "kontakta",
                 "mäklare i", "ditt hem", "hitta", "om oss", "kommersi"]

    img_idx = 0
    for h3 in candidate_h3s:
        broker_name = re.sub(r"\s+", " ", h3.get_text(strip=True))
        # Sanity: real broker names are 2-4 words, alpha only
        if not broker_name or len(broker_name) > 60:
            continue
        if any(c in broker_name for c in ["|", ":", "?", "!", "(", ")"]):
            continue
        if any(b in broker_name.lower() for b in bad_words):
            continue
        parts = broker_name.split()
        if len(parts) < 2 or len(parts) > 5:
            continue
        if not re.match(r"^[A-ZÅÄÖa-zåäö\-' ]+$", broker_name):
            continue

        # Profile URL: walk up to find an ancestor <a href="/personal/...">
        profile_url = ""
        anc = h3
        for _ in range(4):
            if anc is None:
                break
            if anc.name == "a" and anc.get("href", "").startswith("/personal/"):
                profile_url = BASE_URL + anc["href"]
                break
            anc = anc.parent
        if not profile_url:
            # Sometimes the link is a sibling within the same card
            card = h3.find_parent("div")
            if card:
                a = card.find("a", href=re.compile(r"^/personal/"))
                if a:
                    profile_url = BASE_URL + a["href"]

        cur = h3.parent
        tel_v = mail_v = role = ""
        for _ in range(5):
            if cur is None:
                break
            tel_el = cur.select_one("a[href^='tel:']")
            mail_el = cur.select_one("a[href^='mailto:']")
            if tel_el and mail_el:
                tel_v = re.sub(r"\s+", " ", tel_el.get_text(strip=True))
                mail_v = mail_el["href"].replace("mailto:", "").strip()
                for el in cur.find_all(["p", "span", "div"]):
                    txt = el.get_text(strip=True)
                    if not txt or txt == broker_name or len(txt) > 80:
                        continue
                    low = txt.lower()
                    if any(w in low for w in ["mäklare", "assistent", "chef", "vd",
                                              "administ", "ekonomi", "ansvarig",
                                              "partner", "stylist", "fotograf",
                                              "koord", "certif"]):
                        role = txt
                        break
                break
            cur = cur.parent

        # Reject when email is the generic office email
        if mail_v and office_email and mail_v.lower() == office_email.lower():
            continue
        # Reject when email local-part does NOT start with the broker's first name
        if mail_v:
            first = parts[0].lower()
            for sv, en in [("å", "a"), ("ä", "a"), ("ö", "o"), ("é", "e")]:
                first = first.replace(sv, en)
            email_local = mail_v.split("@")[0].lower()
            if first and not email_local.startswith(first[:3]):
                continue
        if not mail_v:
            continue

        avatar = profile_imgs[img_idx] if img_idx < len(profile_imgs) else ""
        if avatar and avatar.startswith("/"):
            avatar = BASE_URL + avatar
        img_idx += 1

        brokers.append({
            "name": broker_name,
            "title": role or "Reg. fastighetsmäklare",
            "phone": tel_v,
            "email": mail_v,
            "avatar_url": avatar,
            "profile_url": profile_url,
        })

    return {
        "name": name,
        "url": url,
        "address": full_address,
        "city": addr_city,
        "postal_code": addr_postal,
        "phone": office_phone,
        "email": office_email,
        "brokers": brokers,
    }


async def _geocode(client: httpx.AsyncClient, city: str, db=None) -> tuple[float, float]:
    if not city:
        return (62.0, 16.0)
    key = _norm_city(city.split("/")[0])
    if key in BUILTIN_COORDS:
        return BUILTIN_COORDS[key]
    # DB cache
    if db is not None:
        cached = await db.geocache.find_one({"city": key}, {"_id": 0})
        if cached:
            return (cached["lat"], cached["lng"])
    # Nominatim fallback
    try:
        q = quote(f"{city.split('/')[0]}, Sweden")
        r = await client.get(
            f"https://nominatim.openstreetmap.org/search?format=json&limit=1&q={q}",
            headers={"User-Agent": "skandia-etablering/1.0"},
            timeout=10,
        )
        if r.status_code == 200:
            arr = r.json()
            if arr:
                lat, lng = float(arr[0]["lat"]), float(arr[0]["lon"])
                if db is not None:
                    await db.geocache.update_one(
                        {"city": key},
                        {"$set": {"city": key, "lat": lat, "lng": lng, "src": "nominatim"}},
                        upsert=True,
                    )
                return (lat, lng)
    except Exception as e:
        logger.warning(f"Geocode failed for {city}: {e}")
    return (62.0, 16.0)


# --- Swedish län (region) detection from city -------------------------------
LAN_BY_CITY = {
    "stockholm": "Stockholms län", "bromma": "Stockholms län", "lidingö": "Stockholms län",
    "nacka": "Stockholms län", "täby": "Stockholms län", "sollentuna": "Stockholms län",
    "solna": "Stockholms län", "sundbyberg": "Stockholms län", "danderyd": "Stockholms län",
    "huddinge": "Stockholms län", "haninge": "Stockholms län", "järfälla": "Stockholms län",
    "norrtälje": "Stockholms län", "vaxholm": "Stockholms län", "värmdö": "Stockholms län",
    "saltsjöbaden": "Stockholms län", "österåker": "Stockholms län", "åkersberga": "Stockholms län",
    "tyresö": "Stockholms län", "upplands bro": "Stockholms län", "upplands väsby": "Stockholms län",
    "sigtuna": "Stockholms län", "botkyrka": "Stockholms län", "salem": "Stockholms län",
    "uppsala": "Uppsala län", "enköping": "Uppsala län",
    "göteborg": "Västra Götalands län", "mölndal": "Västra Götalands län",
    "partille": "Västra Götalands län", "kungälv": "Västra Götalands län",
    "ale": "Västra Götalands län", "borås": "Västra Götalands län",
    "trollhättan": "Västra Götalands län", "vänersborg": "Västra Götalands län",
    "uddevalla": "Västra Götalands län", "stenungsund": "Västra Götalands län",
    "lidköping": "Västra Götalands län", "mariestad": "Västra Götalands län",
    "skövde": "Västra Götalands län", "hjo": "Västra Götalands län",
    "lerum": "Västra Götalands län",
    "malmö": "Skåne län", "lund": "Skåne län", "helsingborg": "Skåne län",
    "landskrona": "Skåne län", "trelleborg": "Skåne län", "kristianstad": "Skåne län",
    "hässleholm": "Skåne län", "ängelholm": "Skåne län", "eslöv": "Skåne län",
    "höör": "Skåne län", "hörby": "Skåne län", "höllviken": "Skåne län",
    "klippan": "Skåne län", "kävlinge": "Skåne län", "lomma": "Skåne län",
    "sjöbo": "Skåne län", "staffanstorp": "Skåne län", "svedala": "Skåne län",
    "bara": "Skåne län", "ystad": "Skåne län",
    "halmstad": "Hallands län", "varberg": "Hallands län", "kungsbacka": "Hallands län",
    "falkenberg": "Hallands län",
    "linköping": "Östergötlands län", "norrköping": "Östergötlands län",
    "motala": "Östergötlands län", "mjölby": "Östergötlands län",
    "jönköping": "Jönköpings län", "eksjö": "Jönköpings län", "värnamo": "Jönköpings län",
    "växjö": "Kronobergs län",
    "kalmar": "Kalmar län",
    "karlskrona": "Blekinge län",
    "karlstad": "Värmlands län",
    "örebro": "Örebro län",
    "västerås": "Västmanlands län", "sala": "Västmanlands län",
    "eskilstuna": "Södermanlands län", "nyköping": "Södermanlands län",
    "oxelösund": "Södermanlands län", "strängnäs": "Södermanlands län",
    "mariefred": "Södermanlands län", "katrineholm": "Södermanlands län",
    "flen": "Södermanlands län", "gnesta": "Södermanlands län", "trosa": "Södermanlands län",
    "södertälje": "Stockholms län",
    "gävle": "Gävleborgs län", "sandviken": "Gävleborgs län",
    "söderhamn": "Gävleborgs län", "hudiksvall": "Gävleborgs län", "bollnäs": "Gävleborgs län",
    "falun": "Dalarnas län", "borlänge": "Dalarnas län", "sälen": "Dalarnas län",
    "sundsvall": "Västernorrlands län", "härnösand": "Västernorrlands län",
    "timrå": "Västernorrlands län", "örnsköldsvik": "Västernorrlands län",
    "östersund": "Jämtlands län", "åre": "Jämtlands län",
    "vemdalen": "Jämtlands län", "funäsdalen": "Jämtlands län",
    "umeå": "Västerbottens län", "skellefteå": "Västerbottens län",
    "luleå": "Norrbottens län", "piteå": "Norrbottens län",
    "visby": "Gotlands län",
}


def _region(city: str) -> str:
    key = _norm_city(city)
    if key in LAN_BY_CITY:
        return LAN_BY_CITY[key]
    # try first word
    first = _norm_city(city.split()[0]) if city else ""
    return LAN_BY_CITY.get(first, "")


async def scrape_offices(limit: Optional[int] = None, db=None) -> dict:
    """Scrape offices + brokers from skandiamaklarna.se.

    Args:
        limit: max number of offices to scrape (None = all)
        db: motor AsyncIOMotorDatabase for geocode cache (optional)

    Returns dict with status, counts, parsed offices+brokers and errors.
    """
    started = datetime.now(timezone.utc)
    headers = {"User-Agent": UA, "Accept-Language": "sv-SE,sv;q=0.9,en;q=0.8"}
    result = {
        "status": "ok",
        "started_at": started.isoformat(),
        "finished_at": None,
        "offices_found": 0,
        "offices_parsed": 0,
        "brokers_parsed": 0,
        "errors": [],
        "offices": [],
    }
    try:
        async with httpx.AsyncClient(headers=headers, follow_redirects=True) as client:
            index_html = await _fetch(client, INDEX_URL)
            if not index_html:
                result["status"] = "blocked"
                result["errors"].append("Kunde inte hämta /kontor/")
                result["finished_at"] = _now_iso()
                return result

            urls = _parse_office_links(index_html)
            result["offices_found"] = len(urls)
            if not urls:
                result["status"] = "no_data"
                result["errors"].append("Inga office-länkar hittades.")
                result["finished_at"] = _now_iso()
                return result

            if limit:
                urls = urls[:limit]

            sem = asyncio.Semaphore(5)

            async def one(url):
                async with sem:
                    html = await _fetch(client, url)
                    if not html:
                        return None
                    parsed = _parse_office_page(url, html)
                    if parsed:
                        lat, lng = await _geocode(client, parsed["city"], db)
                        parsed["lat"] = lat
                        parsed["lng"] = lng
                        parsed["region"] = _region(parsed["city"])
                    return parsed

            parsed_list = await asyncio.gather(*[one(u) for u in urls])
            parsed_list = [p for p in parsed_list if p]
            result["offices_parsed"] = len(parsed_list)
            result["brokers_parsed"] = sum(len(p["brokers"]) for p in parsed_list)
            result["offices"] = parsed_list
    except Exception as e:
        logger.exception("Scrape error")
        result["status"] = "error"
        result["errors"].append(str(e))

    result["finished_at"] = _now_iso()
    return result


def to_office_doc(p: dict) -> dict:
    """Convert scraper output to an `offices` collection document."""
    return {
        "id": _id(),
        "name": p.get("name") or "",
        "city": p.get("city") or "",
        "region": p.get("region") or "",
        "address": p.get("address") or "",
        "phone": p.get("phone") or "",
        "email": p.get("email") or "",
        "manager": "",  # not exposed by site
        "lat": p.get("lat"),
        "lng": p.get("lng"),
        "website": p.get("url"),
        "source": "scrape",
        "scraped_at": _now_iso(),
    }


def to_broker_docs(p: dict, office_doc: dict) -> list[dict]:
    out = []
    for b in p["brokers"]:
        out.append({
            "id": _id(),
            "name": b["name"],
            "title": b.get("title") or "Reg. fastighetsmäklare",
            "phone": b.get("phone") or "",
            "email": b.get("email") or "",
            "avatar_url": b.get("avatar_url") or "",
            "profile_url": b.get("profile_url") or "",
            "office_id": office_doc["id"],
            "office_name": office_doc["name"],
            "city": office_doc["city"],
            "active_listings": 0,
            "ytd_sales": 0,
            "source": "scrape",
            "scraped_at": _now_iso(),
        })
    return out
```


## `backend/storage_service.py`

```python
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
```


## `backend/email_service.py`

```python
"""Resend email service — used for prospect follow-up reminders."""
from __future__ import annotations
import asyncio
import logging
import os

import resend

logger = logging.getLogger(__name__)


def _configured() -> bool:
    key = os.environ.get("RESEND_API_KEY", "")
    return bool(key and key.strip())


async def send_reminder(recipient: str, subject: str, html: str) -> dict:
    """Send a reminder email via Resend.

    Returns {"status": "success"|"skipped"|"error", "message": "...", "email_id": "..."}
    """
    if not _configured():
        return {
            "status": "skipped",
            "message": "RESEND_API_KEY ej konfigurerad — påminnelse loggad men inte skickad.",
        }
    if not recipient:
        return {"status": "error", "message": "Saknar mottagaradress."}

    resend.api_key = os.environ["RESEND_API_KEY"]
    sender = os.environ.get("SENDER_EMAIL", "onboarding@resend.dev")
    params = {
        "from": sender,
        "to": [recipient],
        "subject": subject,
        "html": html,
    }
    try:
        email = await asyncio.to_thread(resend.Emails.send, params)
        return {
            "status": "success",
            "message": f"Mejl skickat till {recipient}",
            "email_id": email.get("id") if isinstance(email, dict) else None,
        }
    except Exception as e:
        logger.exception("Resend error")
        return {"status": "error", "message": str(e)}


def build_reminder_html(prospect_name: str, next_step: str, next_step_date: str,
                        city: str, current_agency: str, notes: str = "") -> str:
    return f"""<!doctype html>
<html><body style="font-family:Arial,Helvetica,sans-serif;background:#FAFAFA;padding:0;margin:0;color:#0A0A0A;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAFA;padding:32px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1px solid #E5E5E5;border-radius:8px;">
<tr><td style="padding:32px;">
<p style="margin:0 0 4px 0;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#52525B;">Skandiamäklarna · Etablering</p>
<h1 style="margin:0 0 24px 0;font-size:24px;font-weight:800;color:#0A0A0A;">Påminnelse: {next_step}</h1>
<p style="margin:0 0 8px 0;font-size:14px;color:#52525B;">Prospekt</p>
<p style="margin:0 0 16px 0;font-size:18px;font-weight:600;color:#0A0A0A;">{prospect_name}</p>
<table cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;font-size:13px;color:#52525B;">
<tr><td style="padding:4px 16px 4px 0;color:#52525B;">Ort</td><td style="color:#0A0A0A;font-weight:600;">{city or '—'}</td></tr>
<tr><td style="padding:4px 16px 4px 0;color:#52525B;">Nuvarande kedja</td><td style="color:#0A0A0A;font-weight:600;">{current_agency or '—'}</td></tr>
<tr><td style="padding:4px 16px 4px 0;color:#52525B;">Nästa steg</td><td style="color:#0A0A0A;font-weight:600;">{next_step or '—'}</td></tr>
<tr><td style="padding:4px 16px 4px 0;color:#52525B;">Datum</td><td style="color:#CBA135;font-weight:700;">{next_step_date or '—'}</td></tr>
</table>
{('<p style="margin:0 0 24px 0;font-size:13px;color:#52525B;border-left:3px solid #CBA135;padding:8px 12px;background:#FAFAFA;">' + notes + '</p>') if notes else ''}
<p style="margin:24px 0 0 0;font-size:11px;color:#A1A1AA;">Skickat från din etableringschef-dashboard.</p>
</td></tr></table>
</td></tr></table>
</body></html>"""
```


## `backend/seed_data.py`

```python
"""Realistic seed data for Skandiamäklarna offices, brokers and active listings.

This represents a snapshot of the network used as the initial baseline. The
'Refresh scrape' endpoint will attempt to update / augment this with live data
from skandiamaklarna.se when triggered.
"""
from __future__ import annotations
import uuid
import random
from datetime import datetime, timezone, timedelta


def _id() -> str:
    return str(uuid.uuid4())


AVATAR_M = "https://images.unsplash.com/photo-1560250097-0b93528c311a?crop=entropy&cs=srgb&fm=jpg&w=400&q=80"
AVATAR_F = "https://images.unsplash.com/photo-1494790108377-be9c29b29330?crop=entropy&cs=srgb&fm=jpg&w=400&q=80"
AVATAR_F2 = "https://images.unsplash.com/photo-1685760259914-ee8d2c92d2e0?crop=entropy&cs=srgb&fm=jpg&w=400&q=80"
AVATAR_M2 = "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?crop=entropy&cs=srgb&fm=jpg&w=400&q=80"
AVATAR_F3 = "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?crop=entropy&cs=srgb&fm=jpg&w=400&q=80"


# Offices: (name, city, region, address, phone, manager, lat, lng)
_OFFICE_RAW = [
    ("Skandiamäklarna Östermalm",    "Stockholm",  "Stockholms län",        "Karlavägen 60, 114 49 Stockholm",   "08-411 80 00", "Henrik Lindqvist",   59.3382, 18.0890),
    ("Skandiamäklarna Vasastan",     "Stockholm",  "Stockholms län",        "Sankt Eriksgatan 88, 113 32 Stockholm", "08-441 90 90", "Cecilia Bergström", 59.3447, 18.0359),
    ("Skandiamäklarna Södermalm",    "Stockholm",  "Stockholms län",        "Götgatan 38, 116 21 Stockholm",     "08-556 11 200", "Pontus Åkerlund",   59.3138, 18.0743),
    ("Skandiamäklarna Bromma",       "Bromma",     "Stockholms län",        "Brommaplan 405, 168 30 Bromma",     "08-704 90 00", "Annika Söderberg",  59.3361, 17.9419),
    ("Skandiamäklarna Lidingö",      "Lidingö",    "Stockholms län",        "Stockholmsvägen 33, 181 33 Lidingö","08-731 50 50", "Mikael Forsén",     59.3645, 18.1326),
    ("Skandiamäklarna Nacka",        "Nacka",      "Stockholms län",        "Sickla Industriväg 6, 131 34 Nacka","08-556 02 350", "Lina Hellberg",     59.3110, 18.1640),
    ("Skandiamäklarna Täby",         "Täby",       "Stockholms län",        "Stora Marknadsvägen 15, 183 34 Täby","08-630 03 30","Daniel Hultman",    59.4439, 18.0686),
    ("Skandiamäklarna Sollentuna",   "Sollentuna", "Stockholms län",        "Aniaraplatsen 4, 191 62 Sollentuna","08-410 31 010","Sofia Wikström",    59.4280, 17.9510),
    ("Skandiamäklarna Solna",        "Solna",      "Stockholms län",        "Råsundavägen 12, 169 67 Solna",     "08-735 60 60", "Erik Lundgren",     59.3611, 18.0008),
    ("Skandiamäklarna Göteborg City","Göteborg",   "Västra Götalands län",  "Kungsportsavenyen 21, 411 36 Göteborg","031-720 24 00","Johanna Carlsson",57.7032, 11.9756),
    ("Skandiamäklarna Hisingen",     "Göteborg",   "Västra Götalands län",  "Wieselgrensplatsen 4, 417 17 Göteborg","031-50 39 20","Robert Engström", 57.7196, 11.9376),
    ("Skandiamäklarna Mölndal",      "Mölndal",    "Västra Götalands län",  "Frölundagatan 31, 431 35 Mölndal",  "031-87 11 30", "Petra Almgren",     57.6554, 12.0138),
    ("Skandiamäklarna Kungsbacka",   "Kungsbacka", "Hallands län",          "Norra Torggatan 3, 434 30 Kungsbacka","0300-56 39 00","Tomas Werner",    57.4878, 12.0759),
    ("Skandiamäklarna Halmstad",     "Halmstad",   "Hallands län",          "Storgatan 22, 302 43 Halmstad",     "035-10 40 60", "Helena Berg",       56.6745, 12.8578),
    ("Skandiamäklarna Varberg",      "Varberg",    "Hallands län",          "Kungsgatan 28, 432 41 Varberg",     "0340-67 49 00", "Marcus Olsson",    57.1057, 12.2502),
    ("Skandiamäklarna Falkenberg",   "Falkenberg", "Hallands län",          "Storgatan 50, 311 32 Falkenberg",   "0346-71 60 00", "Karin Sjöberg",    56.9054, 12.4912),
    ("Skandiamäklarna Malmö City",   "Malmö",      "Skåne län",             "Stortorget 17, 211 22 Malmö",       "040-10 60 00", "Fredrik Nordin",    55.6049, 13.0038),
    ("Skandiamäklarna Lund",         "Lund",       "Skåne län",             "Stora Södergatan 28, 222 23 Lund",  "046-19 22 00", "Emma Persson",      55.7047, 13.1910),
    ("Skandiamäklarna Helsingborg",  "Helsingborg","Skåne län",             "Drottninggatan 26, 252 21 Helsingborg","042-12 41 00","Magnus Holmqvist",56.0465, 12.6945),
    ("Skandiamäklarna Landskrona",   "Landskrona", "Skåne län",             "Östergatan 8, 261 31 Landskrona",   "0418-44 65 00", "Sara Lindholm",    55.8708, 12.8301),
    ("Skandiamäklarna Uppsala",      "Uppsala",    "Uppsala län",           "Kungsängsgatan 20, 753 18 Uppsala", "018-12 41 20", "Joakim Sandberg",   59.8586, 17.6389),
    ("Skandiamäklarna Linköping",    "Linköping",  "Östergötlands län",     "Storgatan 31, 582 24 Linköping",    "013-12 34 00", "Anneli Brandt",     58.4108, 15.6214),
    ("Skandiamäklarna Norrköping",   "Norrköping", "Östergötlands län",     "Drottninggatan 22, 602 24 Norrköping","011-19 23 00","Patrik Nyman",     58.5877, 16.1924),
    ("Skandiamäklarna Jönköping",    "Jönköping",  "Jönköpings län",        "Östra Storgatan 33, 553 21 Jönköping","036-30 73 80","Kristina Eklund", 57.7826, 14.1618),
    ("Skandiamäklarna Karlstad",     "Karlstad",   "Värmlands län",         "Drottninggatan 26, 652 25 Karlstad","054-21 80 80", "Björn Andersson",   59.3793, 13.5036),
    ("Skandiamäklarna Örebro",       "Örebro",     "Örebro län",            "Drottninggatan 32, 702 22 Örebro",  "019-10 22 80", "Camilla Östberg",   59.2741, 15.2066),
    ("Skandiamäklarna Västerås",     "Västerås",   "Västmanlands län",      "Stora Gatan 28, 722 12 Västerås",   "021-12 80 90", "Lars Bjerke",       59.6099, 16.5448),
    ("Skandiamäklarna Gävle",        "Gävle",      "Gävleborgs län",        "Kyrkogatan 20, 803 11 Gävle",       "026-12 04 30", "Ingela Strand",     60.6749, 17.1413),
    ("Skandiamäklarna Sundsvall",    "Sundsvall",  "Västernorrlands län",   "Storgatan 24, 852 30 Sundsvall",    "060-12 33 00", "Per Lundkvist",     62.3908, 17.3069),
    ("Skandiamäklarna Umeå",         "Umeå",       "Västerbottens län",     "Kungsgatan 56, 902 28 Umeå",        "090-12 14 00", "Hanna Berglund",    63.8258, 20.2630),
]


_FIRSTNAMES_F = ["Anna", "Maria", "Sara", "Karin", "Elin", "Lisa", "Sofia", "Emma", "Therese", "Caroline",
                 "Linnea", "Petra", "Lina", "Helena", "Charlotte", "Frida", "Ida", "Klara", "Mathilda", "Julia"]
_FIRSTNAMES_M = ["Anders", "Erik", "Lars", "Magnus", "Karl", "Per", "Niklas", "Mattias", "Daniel", "Fredrik",
                 "Johan", "Henrik", "Mikael", "Oscar", "Patrik", "Stefan", "Tobias", "Viktor", "Christer", "Markus"]
_LASTNAMES = ["Andersson", "Johansson", "Karlsson", "Nilsson", "Eriksson", "Larsson", "Olsson", "Persson",
              "Svensson", "Gustafsson", "Lindberg", "Lindström", "Lindqvist", "Bergström", "Berg", "Holm",
              "Wallin", "Sundström", "Hansson", "Forsberg", "Sjöberg", "Engström", "Åberg", "Hellström"]

TITLES = ["Reg. fastighetsmäklare", "Mäklarassistent", "Reg. fastighetsmäklare", "Kontorschef",
          "Reg. fastighetsmäklare", "Reg. fastighetsmäklare"]
LISTING_TYPES = ["Lägenhet", "Villa", "Radhus", "Fritidshus", "Tomt", "Kedjehus"]


def _slug(name: str) -> str:
    return (name.lower()
            .replace("å", "a").replace("ä", "a").replace("ö", "o")
            .replace(" ", ".").replace("'", ""))


def build_seed():
    random.seed(42)
    offices, brokers, listings = [], [], []
    now = datetime.now(timezone.utc).isoformat()

    for raw in _OFFICE_RAW:
        name, city, region, address, phone, manager, lat, lng = raw
        office_id = _id()
        slug = name.lower().replace("skandiamäklarna ", "").replace(" ", "-")
        offices.append({
            "id": office_id,
            "name": name,
            "city": city,
            "region": region,
            "address": address,
            "phone": phone,
            "manager": manager,
            "lat": lat,
            "lng": lng,
            "email": f"{slug}@skandiamaklarna.se".replace("å", "a").replace("ä", "a").replace("ö", "o"),
            "website": f"https://www.skandiamaklarna.se/maklare/{slug}",
            "source": "seed",
            "scraped_at": now,
        })

        broker_count = random.randint(4, 9)
        for i in range(broker_count):
            is_f = random.random() > 0.45
            first = random.choice(_FIRSTNAMES_F if is_f else _FIRSTNAMES_M)
            last = random.choice(_LASTNAMES)
            full = f"{first} {last}"
            broker_id = _id()
            title = "Kontorschef" if (i == 0 and manager == full) else random.choice(TITLES)
            if i == 0:
                full = manager
                title = "Kontorschef"
            avatar = random.choice([AVATAR_F, AVATAR_F2, AVATAR_F3]) if is_f or i == 0 and manager.split()[0] in _FIRSTNAMES_F else random.choice([AVATAR_M, AVATAR_M2])
            brokers.append({
                "id": broker_id,
                "name": full,
                "title": title,
                "phone": f"0{random.randint(70, 76)}-{random.randint(100,999)} {random.randint(10,99)} {random.randint(10,99)}",
                "email": f"{_slug(full)}@skandiamaklarna.se",
                "avatar_url": avatar,
                "office_id": office_id,
                "office_name": name,
                "city": city,
                "active_listings": random.randint(0, 12),
                "ytd_sales": random.randint(8, 45),
                "source": "seed",
                "scraped_at": now,
            })

            # Active listings for this broker
            for _ in range(random.randint(0, 5)):
                lt = random.choice(LISTING_TYPES)
                price = random.randint(1_500, 22_000) * 1000
                listings.append({
                    "id": _id(),
                    "broker_id": broker_id,
                    "broker_name": full,
                    "office_id": office_id,
                    "office_name": name,
                    "city": city,
                    "type": lt,
                    "rooms": random.randint(1, 7),
                    "area_sqm": random.randint(28, 250),
                    "price_sek": price,
                    "address": f"{random.choice(['Storgatan','Östra vägen','Skolgatan','Parkvägen','Strandgatan','Kyrkogatan'])} {random.randint(1, 99)}",
                    "status": "Till salu",
                    "listed_at": (datetime.now(timezone.utc) - timedelta(days=random.randint(1, 90))).isoformat(),
                    "source": "seed",
                })

    return offices, brokers, listings


# Initial prospects (värvningsprospekt)
def build_prospects(offices):
    """A handful of seed prospects so the kanban isn't empty."""
    now = datetime.now(timezone.utc)
    return [
        {
            "id": _id(),
            "name": "Anna Lundberg",
            "type": "broker",
            "current_agency": "Fastighetsbyrån",
            "city": "Borås",
            "region": "Västra Götalands län",
            "phone": "070-555 12 34",
            "email": "anna.lundberg@example.se",
            "linkedin": "https://www.linkedin.com/in/anna-lundberg-example",
            "status": "Kontaktad",
            "notes": "Toppsäljare i Borås, 12 år i branschen. Visat intresse via gemensam kontakt.",
            "next_step_date": (now + timedelta(days=4)).isoformat(),
            "next_step": "Telefonmöte 14:00",
            "created_at": (now - timedelta(days=12)).isoformat(),
            "updated_at": (now - timedelta(days=2)).isoformat(),
            "tags": ["high-priority", "topp-säljare"],
        },
        {
            "id": _id(),
            "name": "Oskar Bergqvist",
            "type": "broker",
            "current_agency": "Svensk Fastighetsförmedling",
            "city": "Karlskrona",
            "region": "Blekinge län",
            "phone": "073-211 88 90",
            "email": "oskar.b@example.se",
            "linkedin": "https://www.linkedin.com/in/oskar-bergqvist-example",
            "status": "Möte bokat",
            "notes": "Vill öppna eget kontor. Söker varumärke + back office.",
            "next_step_date": (now + timedelta(days=2)).isoformat(),
            "next_step": "Lunchmöte Karlskrona",
            "created_at": (now - timedelta(days=21)).isoformat(),
            "updated_at": (now - timedelta(days=1)).isoformat(),
            "tags": ["nytt-kontor"],
        },
        {
            "id": _id(),
            "name": "Maria Eklund",
            "type": "broker",
            "current_agency": "HusmanHagberg",
            "city": "Borlänge",
            "region": "Dalarnas län",
            "phone": "076-998 22 11",
            "email": "maria.eklund@example.se",
            "linkedin": "",
            "status": "Identifierad",
            "notes": "Identifierad via Hemnet — 38 sålda objekt senaste året.",
            "next_step_date": (now + timedelta(days=7)).isoformat(),
            "next_step": "Skicka första kontakt-mejl",
            "created_at": (now - timedelta(days=3)).isoformat(),
            "updated_at": (now - timedelta(days=3)).isoformat(),
            "tags": [],
        },
        {
            "id": _id(),
            "name": "Skandiamäklarna Visby (nytt kontor)",
            "type": "office",
            "current_agency": "—",
            "city": "Visby",
            "region": "Gotlands län",
            "phone": "",
            "email": "",
            "linkedin": "",
            "status": "Förhandling",
            "notes": "Partner identifierad: Johan Wallin. Lokalkontrakt under granskning.",
            "next_step_date": (now + timedelta(days=10)).isoformat(),
            "next_step": "Avtalsgenomgång med jurist",
            "created_at": (now - timedelta(days=45)).isoformat(),
            "updated_at": (now - timedelta(days=4)).isoformat(),
            "tags": ["white-spot", "nytt-kontor"],
        },
        {
            "id": _id(),
            "name": "Johan Wallin",
            "type": "broker",
            "current_agency": "Egen",
            "city": "Visby",
            "region": "Gotlands län",
            "phone": "070-712 09 87",
            "email": "johan.wallin@example.se",
            "linkedin": "https://www.linkedin.com/in/johan-wallin-example",
            "status": "Signerad",
            "notes": "Tilltänkt kontorschef för Visby. Signerad LOI.",
            "next_step_date": (now + timedelta(days=14)).isoformat(),
            "next_step": "Onboarding-paket",
            "created_at": (now - timedelta(days=60)).isoformat(),
            "updated_at": (now - timedelta(days=6)).isoformat(),
            "tags": ["kontorschef"],
        },
        {
            "id": _id(),
            "name": "Petra Söderlund",
            "type": "broker",
            "current_agency": "Länsförsäkringar Fastighetsförmedling",
            "city": "Kalmar",
            "region": "Kalmar län",
            "phone": "070-455 11 22",
            "email": "petra.s@example.se",
            "linkedin": "",
            "status": "Onboardad",
            "notes": "Tillträde 2026-03-01. Klar för marknadslansering.",
            "next_step_date": (now + timedelta(days=20)).isoformat(),
            "next_step": "PR-lansering",
            "created_at": (now - timedelta(days=120)).isoformat(),
            "updated_at": (now - timedelta(days=8)).isoformat(),
            "tags": ["onboarded"],
        },
    ]


# Default goals
def build_goals():
    now = datetime.now(timezone.utc).isoformat()
    return [
        {"id": _id(), "title": "5 nya kontor Q1 2026", "target": 5, "current": 2, "metric": "Signerade kontor", "deadline": "2026-03-31", "created_at": now},
        {"id": _id(), "title": "20 nya mäklare H1 2026", "target": 20, "current": 7, "metric": "Onboardade mäklare", "deadline": "2026-06-30", "created_at": now},
        {"id": _id(), "title": "Täcka 3 nya regioner", "target": 3, "current": 1, "metric": "Nya regioner", "deadline": "2026-12-31", "created_at": now},
    ]


def build_activity_seed(prospects):
    now = datetime.now(timezone.utc)
    log = []
    for p in prospects[:5]:
        log.append({
            "id": _id(),
            "kind": "status_change",
            "prospect_id": p["id"],
            "prospect_name": p["name"],
            "from_status": "Identifierad",
            "to_status": p["status"],
            "message": f"{p['name']} flyttades till {p['status']}",
            "created_at": (now - timedelta(days=random.randint(1, 9), hours=random.randint(0, 23))).isoformat(),
        })
    log.append({
        "id": _id(),
        "kind": "scrape",
        "prospect_id": None,
        "prospect_name": None,
        "from_status": None,
        "to_status": None,
        "message": "Initial datainsamling slutförd — 30 kontor seedade",
        "created_at": (now - timedelta(days=1)).isoformat(),
    })
    return log
```


## `backend/municipalities_data.py`

```python
"""Top 60 Swedish municipalities by population with coordinates and competitor presence
estimates. Used for the 'white spots' map / market gap analysis.
"""

# Each entry: name, region (län), latitude, longitude, population (approx 2024),
# transactions_per_year (rough estimate of bostadstransaktioner).
MUNICIPALITIES = [
    {"name": "Stockholm", "region": "Stockholms län", "lat": 59.3293, "lng": 18.0686, "population": 988943, "transactions": 18000},
    {"name": "Göteborg", "region": "Västra Götalands län", "lat": 57.7089, "lng": 11.9746, "population": 605000, "transactions": 11000},
    {"name": "Malmö", "region": "Skåne län", "lat": 55.6049, "lng": 13.0038, "population": 357377, "transactions": 7200},
    {"name": "Uppsala", "region": "Uppsala län", "lat": 59.8586, "lng": 17.6389, "population": 245000, "transactions": 4900},
    {"name": "Linköping", "region": "Östergötlands län", "lat": 58.4108, "lng": 15.6214, "population": 167000, "transactions": 3400},
    {"name": "Västerås", "region": "Västmanlands län", "lat": 59.6099, "lng": 16.5448, "population": 158653, "transactions": 3200},
    {"name": "Örebro", "region": "Örebro län", "lat": 59.2741, "lng": 15.2066, "population": 158057, "transactions": 3100},
    {"name": "Helsingborg", "region": "Skåne län", "lat": 56.0465, "lng": 12.6945, "population": 150975, "transactions": 3000},
    {"name": "Norrköping", "region": "Östergötlands län", "lat": 58.5877, "lng": 16.1924, "population": 145076, "transactions": 2900},
    {"name": "Jönköping", "region": "Jönköpings län", "lat": 57.7826, "lng": 14.1618, "population": 144817, "transactions": 2800},
    {"name": "Lund", "region": "Skåne län", "lat": 55.7047, "lng": 13.1910, "population": 130000, "transactions": 2600},
    {"name": "Umeå", "region": "Västerbottens län", "lat": 63.8258, "lng": 20.2630, "population": 132051, "transactions": 2600},
    {"name": "Gävle", "region": "Gävleborgs län", "lat": 60.6749, "lng": 17.1413, "population": 103526, "transactions": 2100},
    {"name": "Borås", "region": "Västra Götalands län", "lat": 57.7210, "lng": 12.9401, "population": 115423, "transactions": 2300},
    {"name": "Eskilstuna", "region": "Södermanlands län", "lat": 59.3711, "lng": 16.5092, "population": 108011, "transactions": 2150},
    {"name": "Södertälje", "region": "Stockholms län", "lat": 59.1955, "lng": 17.6253, "population": 102257, "transactions": 2000},
    {"name": "Karlstad", "region": "Värmlands län", "lat": 59.3793, "lng": 13.5036, "population": 96466, "transactions": 1900},
    {"name": "Täby", "region": "Stockholms län", "lat": 59.4439, "lng": 18.0686, "population": 75983, "transactions": 1500},
    {"name": "Växjö", "region": "Kronobergs län", "lat": 56.8777, "lng": 14.8094, "population": 96075, "transactions": 1900},
    {"name": "Halmstad", "region": "Hallands län", "lat": 56.6745, "lng": 12.8578, "population": 105129, "transactions": 2100},
    {"name": "Sundsvall", "region": "Västernorrlands län", "lat": 62.3908, "lng": 17.3069, "population": 99685, "transactions": 1950},
    {"name": "Luleå", "region": "Norrbottens län", "lat": 65.5848, "lng": 22.1547, "population": 79202, "transactions": 1500},
    {"name": "Trollhättan", "region": "Västra Götalands län", "lat": 58.2837, "lng": 12.2886, "population": 60000, "transactions": 1200},
    {"name": "Östersund", "region": "Jämtlands län", "lat": 63.1792, "lng": 14.6357, "population": 64171, "transactions": 1280},
    {"name": "Kalmar", "region": "Kalmar län", "lat": 56.6634, "lng": 16.3568, "population": 71026, "transactions": 1400},
    {"name": "Falun", "region": "Dalarnas län", "lat": 60.6066, "lng": 15.6355, "population": 59558, "transactions": 1180},
    {"name": "Skellefteå", "region": "Västerbottens län", "lat": 64.7507, "lng": 20.9528, "population": 76281, "transactions": 1500},
    {"name": "Kristianstad", "region": "Skåne län", "lat": 56.0294, "lng": 14.1567, "population": 86529, "transactions": 1700},
    {"name": "Karlskrona", "region": "Blekinge län", "lat": 56.1612, "lng": 15.5869, "population": 66776, "transactions": 1300},
    {"name": "Skövde", "region": "Västra Götalands län", "lat": 58.3911, "lng": 13.8451, "population": 58000, "transactions": 1150},
    {"name": "Uddevalla", "region": "Västra Götalands län", "lat": 58.3498, "lng": 11.9416, "population": 57100, "transactions": 1140},
    {"name": "Varberg", "region": "Hallands län", "lat": 57.1057, "lng": 12.2502, "population": 67000, "transactions": 1340},
    {"name": "Lidköping", "region": "Västra Götalands län", "lat": 58.5076, "lng": 13.1576, "population": 41109, "transactions": 820},
    {"name": "Motala", "region": "Östergötlands län", "lat": 58.5403, "lng": 15.0438, "population": 44000, "transactions": 880},
    {"name": "Trelleborg", "region": "Skåne län", "lat": 55.3753, "lng": 13.1574, "population": 47000, "transactions": 940},
    {"name": "Sandviken", "region": "Gävleborgs län", "lat": 60.6173, "lng": 16.7763, "population": 39000, "transactions": 770},
    {"name": "Härnösand", "region": "Västernorrlands län", "lat": 62.6322, "lng": 17.9379, "population": 25000, "transactions": 500},
    {"name": "Vänersborg", "region": "Västra Götalands län", "lat": 58.3811, "lng": 12.3239, "population": 40000, "transactions": 800},
    {"name": "Borlänge", "region": "Dalarnas län", "lat": 60.4858, "lng": 15.4371, "population": 52000, "transactions": 1040},
    {"name": "Nyköping", "region": "Södermanlands län", "lat": 58.7531, "lng": 17.0086, "population": 58000, "transactions": 1160},
    {"name": "Hässleholm", "region": "Skåne län", "lat": 56.1591, "lng": 13.7660, "population": 53000, "transactions": 1060},
    {"name": "Landskrona", "region": "Skåne län", "lat": 55.8708, "lng": 12.8301, "population": 47000, "transactions": 940},
    {"name": "Ängelholm", "region": "Skåne län", "lat": 56.2428, "lng": 12.8624, "population": 43000, "transactions": 860},
    {"name": "Kungälv", "region": "Västra Götalands län", "lat": 57.8702, "lng": 11.9745, "population": 47000, "transactions": 940},
    {"name": "Piteå", "region": "Norrbottens län", "lat": 65.3170, "lng": 21.4794, "population": 42000, "transactions": 800},
    {"name": "Lerum", "region": "Västra Götalands län", "lat": 57.7700, "lng": 12.2685, "population": 44000, "transactions": 880},
    {"name": "Sigtuna", "region": "Stockholms län", "lat": 59.6175, "lng": 17.7203, "population": 50000, "transactions": 1000},
    {"name": "Värnamo", "region": "Jönköpings län", "lat": 57.1856, "lng": 14.0444, "population": 35000, "transactions": 700},
    {"name": "Strängnäs", "region": "Södermanlands län", "lat": 59.3779, "lng": 17.0337, "population": 38000, "transactions": 760},
    {"name": "Enköping", "region": "Uppsala län", "lat": 59.6363, "lng": 17.0773, "population": 47000, "transactions": 940},
    {"name": "Kungsbacka", "region": "Hallands län", "lat": 57.4878, "lng": 12.0759, "population": 86000, "transactions": 1720},
    {"name": "Mölndal", "region": "Västra Götalands län", "lat": 57.6554, "lng": 12.0138, "population": 71000, "transactions": 1420},
    {"name": "Partille", "region": "Västra Götalands län", "lat": 57.7395, "lng": 12.1066, "population": 41000, "transactions": 820},
    {"name": "Lidingö", "region": "Stockholms län", "lat": 59.3645, "lng": 18.1326, "population": 49000, "transactions": 980},
    {"name": "Nacka", "region": "Stockholms län", "lat": 59.3110, "lng": 18.1640, "population": 109000, "transactions": 2180},
    {"name": "Sollentuna", "region": "Stockholms län", "lat": 59.4280, "lng": 17.9510, "population": 76000, "transactions": 1520},
    {"name": "Solna", "region": "Stockholms län", "lat": 59.3611, "lng": 18.0008, "population": 86000, "transactions": 1720},
    {"name": "Falkenberg", "region": "Hallands län", "lat": 56.9054, "lng": 12.4912, "population": 47000, "transactions": 940},
    {"name": "Bromma", "region": "Stockholms län", "lat": 59.3361, "lng": 17.9419, "population": 78000, "transactions": 1560},
    {"name": "Visby", "region": "Gotlands län", "lat": 57.6348, "lng": 18.2948, "population": 25000, "transactions": 500},
]


def get_municipality(name: str):
    for m in MUNICIPALITIES:
        if m["name"].lower() == name.lower():
            return m
    return None
```


## `backend/requirements.txt`

```python
aiohappyeyeballs==2.6.2
aiohttp==3.13.5
aiosignal==1.4.0
annotated-doc==0.0.4
annotated-types==0.7.0
anyio==4.13.0
ast_serialize==0.5.0
attrs==26.1.0
bcrypt==4.1.3
beautifulsoup4==4.14.3
black==26.5.1
boto3==1.43.13
botocore==1.43.13
certifi==2026.5.20
cffi==2.0.0
charset-normalizer==3.4.7
click==8.4.1
cryptography==48.0.0
distro==1.9.0
dnspython==2.8.0
ecdsa==0.19.2
email-validator==2.3.0
emergentintegrations==0.1.0
fastapi==0.110.1
fastuuid==0.14.0
filelock==3.29.0
flake8==7.3.0
frozenlist==1.8.0
fsspec==2026.4.0
google-ai-generativelanguage==0.6.15
google-api-core==2.30.3
google-api-python-client==2.196.0
google-auth==2.53.0
google-auth-httplib2==0.4.0
google-genai==2.6.0
google-generativeai==0.8.6
googleapis-common-protos==1.75.0
grpcio==1.80.0
grpcio-status==1.71.2
h11==0.16.0
hf-xet==1.5.0
httpcore==1.0.9
httplib2==0.31.2
httpx==0.28.1
huggingface_hub==1.16.1
idna==3.16
importlib_metadata==9.0.0
iniconfig==2.3.0
isort==8.0.1
Jinja2==3.1.6
jiter==0.15.0
jmespath==1.1.0
jq==1.11.0
jsonschema==4.26.0
jsonschema-specifications==2025.9.1
librt==0.11.0
litellm==1.80.0
lxml==6.1.1
markdown-it-py==4.2.0
MarkupSafe==3.0.3
mccabe==0.7.0
mdurl==0.1.2
motor==3.3.1
multidict==6.7.1
mypy==2.1.0
mypy_extensions==1.1.0
numpy==2.4.6
oauthlib==3.3.1
openai==1.99.9
packaging==26.2
pandas==3.0.3
passlib==1.7.4
pathspec==1.1.1
pillow==12.2.0
platformdirs==4.9.6
pluggy==1.6.0
propcache==0.5.2
proto-plus==1.28.0
protobuf==5.29.6
pyasn1==0.6.3
pyasn1_modules==0.4.2
pycodestyle==2.14.0
pycparser==3.0
pydantic==2.13.4
pydantic_core==2.46.4
pyflakes==3.4.0
Pygments==2.20.0
PyJWT==2.13.0
pymongo==4.5.0
pyparsing==3.3.2
pytest==9.0.3
python-dateutil==2.9.0.post0
python-dotenv==1.2.2
python-jose==3.5.0
python-multipart==0.0.29
pytokens==0.4.1
PyYAML==6.0.3
referencing==0.37.0
regex==2026.5.9
requests==2.34.2
requests-oauthlib==2.0.0
resend==2.30.1
rich==15.0.0
rpds-py==0.30.0
rsa==4.9.1
s3transfer==0.17.0
s5cmd==0.2.0
shellingham==1.5.4
six==1.17.0
sniffio==1.3.1
soupsieve==2.8.3
starlette==0.37.2
stripe==15.1.0
tenacity==9.1.4
tiktoken==0.13.0
tokenizers==0.23.1
tqdm==4.67.3
typer==0.25.1
typing-inspection==0.4.2
typing_extensions==4.15.0
tzdata==2026.2
uritemplate==4.2.0
urllib3==2.7.0
uvicorn==0.25.0
watchfiles==1.2.0
websockets==16.0
yarl==1.24.2
zipp==4.1.0
```

---

# FRONTEND


## `frontend/package.json`

```json
{
  "name": "frontend",
  "version": "0.1.0",
  "private": true,
  "dependencies": {
    "@hookform/resolvers": "^5.0.1",
    "@phosphor-icons/react": "^2.1.10",
    "@radix-ui/react-accordion": "^1.2.8",
    "@radix-ui/react-alert-dialog": "^1.1.11",
    "@radix-ui/react-aspect-ratio": "^1.1.4",
    "@radix-ui/react-avatar": "^1.1.7",
    "@radix-ui/react-checkbox": "^1.2.3",
    "@radix-ui/react-collapsible": "^1.1.8",
    "@radix-ui/react-context-menu": "^2.2.12",
    "@radix-ui/react-dialog": "^1.1.11",
    "@radix-ui/react-dropdown-menu": "^2.1.12",
    "@radix-ui/react-hover-card": "^1.1.11",
    "@radix-ui/react-label": "^2.1.4",
    "@radix-ui/react-menubar": "^1.1.12",
    "@radix-ui/react-navigation-menu": "^1.2.10",
    "@radix-ui/react-popover": "^1.1.11",
    "@radix-ui/react-progress": "^1.1.4",
    "@radix-ui/react-radio-group": "^1.3.4",
    "@radix-ui/react-scroll-area": "^1.2.6",
    "@radix-ui/react-select": "^2.2.2",
    "@radix-ui/react-separator": "^1.1.4",
    "@radix-ui/react-slider": "^1.3.2",
    "@radix-ui/react-slot": "^1.2.0",
    "@radix-ui/react-switch": "^1.2.2",
    "@radix-ui/react-tabs": "^1.1.9",
    "@radix-ui/react-toast": "^1.2.11",
    "@radix-ui/react-toggle": "^1.1.6",
    "@radix-ui/react-toggle-group": "^1.1.7",
    "@radix-ui/react-tooltip": "^1.2.4",
    "axios": "^1.8.4",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "cmdk": "^1.1.1",
    "cra-template": "1.2.0",
    "date-fns": "^4.1.0",
    "embla-carousel-react": "^8.6.0",
    "input-otp": "^1.4.2",
    "leaflet": "^1.9.4",
    "lucide-react": "^0.507.0",
    "next-themes": "^0.4.6",
    "react": "^19.0.0",
    "react-day-picker": "8.10.1",
    "react-dom": "^19.0.0",
    "react-hook-form": "^7.56.2",
    "react-leaflet": "^5.0.0",
    "react-resizable-panels": "^3.0.1",
    "react-router-dom": "^7.5.1",
    "react-scripts": "5.0.1",
    "recharts": "^3.6.0",
    "sonner": "^2.0.3",
    "tailwind-merge": "^3.2.0",
    "tailwindcss-animate": "^1.0.7",
    "vaul": "^1.1.2",
    "zod": "^3.24.4"
  },
  "scripts": {
    "start": "craco start",
    "build": "craco build",
    "test": "craco test"
  },
  "browserslist": {
    "production": [
      ">0.2%",
      "not dead",
      "not op_mini all"
    ],
    "development": [
      "last 1 chrome version",
      "last 1 firefox version",
      "last 1 safari version"
    ]
  },
  "devDependencies": {
    "@babel/plugin-proposal-private-property-in-object": "^7.21.11",
    "@craco/craco": "^7.1.0",
    "@emergentbase/visual-edits": "https://assets.emergent.sh/npm/emergentbase-visual-edits-1.0.8.tgz",
    "@eslint/js": "9.23.0",
    "autoprefixer": "^10.4.20",
    "eslint": "9.23.0",
    "eslint-plugin-import": "2.31.0",
    "eslint-plugin-jsx-a11y": "6.10.2",
    "eslint-plugin-react": "7.37.4",
    "eslint-plugin-react-hooks": "5.2.0",
    "globals": "15.15.0",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.17"
  },
  "packageManager": "yarn@1.22.22+sha512.a6b2f7906b721bba3d67d4aff083df04dad64c399707841b7acf00f6b133b7ac24255f2652fa22ae3534329dc6180534e98d17432037ff6fd140556e2bb3137e"
}
```


## `frontend/tailwind.config.js`

```jsx
/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: ["class"],
    content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "./public/index.html"
  ],
  theme: {
  	extend: {
  		borderRadius: {
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)'
  		},
  		colors: {
  			background: 'hsl(var(--background))',
  			foreground: 'hsl(var(--foreground))',
  			card: {
  				DEFAULT: 'hsl(var(--card))',
  				foreground: 'hsl(var(--card-foreground))'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--popover))',
  				foreground: 'hsl(var(--popover-foreground))'
  			},
  			primary: {
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--secondary))',
  				foreground: 'hsl(var(--secondary-foreground))'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			accent: {
  				DEFAULT: 'hsl(var(--accent))',
  				foreground: 'hsl(var(--accent-foreground))'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive))',
  				foreground: 'hsl(var(--destructive-foreground))'
  			},
  			border: 'hsl(var(--border))',
  			input: 'hsl(var(--input))',
  			ring: 'hsl(var(--ring))',
  			chart: {
  				'1': 'hsl(var(--chart-1))',
  				'2': 'hsl(var(--chart-2))',
  				'3': 'hsl(var(--chart-3))',
  				'4': 'hsl(var(--chart-4))',
  				'5': 'hsl(var(--chart-5))'
  			}
  		},
  		keyframes: {
  			'accordion-down': {
  				from: {
  					height: '0'
  				},
  				to: {
  					height: 'var(--radix-accordion-content-height)'
  				}
  			},
  			'accordion-up': {
  				from: {
  					height: 'var(--radix-accordion-content-height)'
  				},
  				to: {
  					height: '0'
  				}
  			}
  		},
  		animation: {
  			'accordion-down': 'accordion-down 0.2s ease-out',
  			'accordion-up': 'accordion-up 0.2s ease-out'
  		}
  	}
  },
  plugins: [require("tailwindcss-animate")],
};```


## `frontend/postcss.config.js`

```jsx
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
```


## `frontend/craco.config.js`

```jsx
// craco.config.js
const path = require("path");
require("dotenv").config();

// Check if we're in development/preview mode (not production build)
// Craco sets NODE_ENV=development for start, NODE_ENV=production for build
const isDevServer = process.env.NODE_ENV !== "production";

// Environment variable overrides
const config = {
  enableHealthCheck: process.env.ENABLE_HEALTH_CHECK === "true",
};

// Conditionally load health check modules only if enabled
let WebpackHealthPlugin;
let setupHealthEndpoints;
let healthPluginInstance;

if (config.enableHealthCheck) {
  WebpackHealthPlugin = require("./plugins/health-check/webpack-health-plugin");
  setupHealthEndpoints = require("./plugins/health-check/health-endpoints");
  healthPluginInstance = new WebpackHealthPlugin();
}

let webpackConfig = {
  eslint: {
    configure: {
      extends: ["plugin:react-hooks/recommended"],
      rules: {
        "react-hooks/rules-of-hooks": "error",
        "react-hooks/exhaustive-deps": "warn",
      },
    },
  },
  webpack: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
    configure: (webpackConfig) => {

      // Add ignored patterns to reduce watched directories
        webpackConfig.watchOptions = {
          ...webpackConfig.watchOptions,
          ignored: [
            '**/node_modules/**',
            '**/.git/**',
            '**/build/**',
            '**/dist/**',
            '**/coverage/**',
            '**/public/**',
        ],
      };

      // Add health check plugin to webpack if enabled
      if (config.enableHealthCheck && healthPluginInstance) {
        webpackConfig.plugins.push(healthPluginInstance);
      }
      return webpackConfig;
    },
  },
};

webpackConfig.devServer = (devServerConfig) => {
  // Add health check endpoints if enabled
  if (config.enableHealthCheck && setupHealthEndpoints && healthPluginInstance) {
    const originalSetupMiddlewares = devServerConfig.setupMiddlewares;

    devServerConfig.setupMiddlewares = (middlewares, devServer) => {
      // Call original setup if exists
      if (originalSetupMiddlewares) {
        middlewares = originalSetupMiddlewares(middlewares, devServer);
      }

      // Setup health endpoints
      setupHealthEndpoints(devServer, healthPluginInstance);

      return middlewares;
    };
  }

  return devServerConfig;
};

// Wrap with visual edits (automatically adds babel plugin, dev server, and overlay in dev mode)
if (isDevServer) {
  try {
    const { withVisualEdits } = require("@emergentbase/visual-edits/craco");
    webpackConfig = withVisualEdits(webpackConfig);
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' && err.message.includes('@emergentbase/visual-edits/craco')) {
      console.warn(
        "[visual-edits] @emergentbase/visual-edits not installed — visual editing disabled."
      );
    } else {
      throw err;
    }
  }
}

module.exports = webpackConfig;
```


## `frontend/src/index.js`

```jsx
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import App from "@/App";

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```


## `frontend/src/App.js`

```jsx
import "@/index.css";
import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider, useAuth } from "@/lib/auth";
import Layout from "@/components/Layout";
import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import Pipeline from "@/pages/Pipeline";
import Offices from "@/pages/Offices";
import Brokers from "@/pages/Brokers";
import MapView from "@/pages/MapView";
import Scrape from "@/pages/Scrape";
import Settings from "@/pages/Settings";
import Team from "@/pages/Team";
import Lost from "@/pages/Lost";
import OfficeDetail from "@/pages/OfficeDetail";

function ProtectedRoute({ children, adminOnly = false }) {
  const { user } = useAuth();
  const location = useLocation();
  if (user === null) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-[#52525B] font-body">
        Laddar…
      </div>
    );
  }
  if (user === false) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  if (adminOnly && user.role !== "admin") {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          <div className="overline">403</div>
          <h2 className="font-display font-extrabold tracking-tight text-2xl mt-1">Endast admin</h2>
          <p className="text-sm text-[#52525B] mt-2 font-body">
            Du har inte behörighet att se den här sidan.
          </p>
        </div>
      </div>
    );
  }
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <Layout>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/pipeline" element={<Pipeline />} />
                <Route path="/offices" element={<Offices />} />
                <Route path="/offices/:id" element={<OfficeDetail />} />
                <Route path="/brokers" element={<Brokers />} />
                <Route path="/map" element={<MapView />} />
                <Route path="/scrape" element={<Scrape />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/team" element={<Team />} />
                <Route path="/lost" element={<Lost />} />
              </Routes>
            </Layout>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <div className="App">
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
      <Toaster position="top-right" richColors closeButton />
    </div>
  );
}
```


## `frontend/src/index.css`

```css
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Manrope:wght@300;400;500;600;700;800&display=swap');
@import "leaflet/dist/leaflet.css";

@tailwind base;
@tailwind components;
@tailwind utilities;

/* Hide injected Emergent badge */
#emergent-badge,
a#emergent-badge,
[id="emergent-badge"] {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
}

:root {
    --bg-page: #FAFAFA;
    --bg-surface: #FFFFFF;
    --bg-muted: #F4F4F5;
    --border-default: #E5E5E5;
    --border-strong: #D4D4D8;
    --text-primary: #0A0A0A;
    --text-secondary: #52525B;
    --text-muted: #A1A1AA;
    --brand-gold: #CBA135;
    --brand-gold-hover: #A67C00;
    --brand-gold-soft: #FAF3E1;
    --status-success: #22C55E;
    --status-warning: #F59E0B;
    --status-error: #EF4444;
    --font-display: 'Manrope', system-ui, sans-serif;
    --font-body: 'IBM Plex Sans', system-ui, sans-serif;
}

@layer base {
    :root {
        --background: 0 0% 98%;
        --foreground: 0 0% 4%;
        --card: 0 0% 100%;
        --card-foreground: 0 0% 4%;
        --popover: 0 0% 100%;
        --popover-foreground: 0 0% 4%;
        --primary: 0 0% 4%;
        --primary-foreground: 0 0% 100%;
        --secondary: 0 0% 96%;
        --secondary-foreground: 0 0% 4%;
        --muted: 0 0% 96%;
        --muted-foreground: 0 0% 32%;
        --accent: 41 56% 50%;
        --accent-foreground: 0 0% 4%;
        --destructive: 0 84% 60%;
        --destructive-foreground: 0 0% 100%;
        --border: 0 0% 90%;
        --input: 0 0% 90%;
        --ring: 41 56% 50%;
        --radius: 0.5rem;
    }
}

* {
    border-color: hsl(var(--border));
}

html,
body,
#root {
    height: 100%;
}

body {
    margin: 0;
    background: var(--bg-page);
    color: var(--text-primary);
    font-family: var(--font-body);
    font-size: 14px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
}

::selection {
    background: var(--brand-gold);
    color: #000;
}

h1,
h2,
h3,
h4,
h5 {
    font-family: var(--font-display);
    color: var(--text-primary);
    letter-spacing: -0.02em;
}

.font-display {
    font-family: var(--font-display);
}

.font-body {
    font-family: var(--font-body);
}

.overline {
    font-family: var(--font-display);
    font-size: 11px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    font-weight: 700;
    color: var(--text-secondary);
}

.card-surface {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: 8px;
}

.btn-primary {
    background: var(--text-primary);
    color: #fff;
    border: 1px solid var(--text-primary);
    border-radius: 6px;
    padding: 8px 14px;
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 13px;
    letter-spacing: -0.005em;
    transition: background-color 180ms ease, color 180ms ease,
        border-color 180ms ease, transform 180ms ease;
    cursor: pointer;
}

.btn-primary:hover {
    background: var(--brand-gold);
    border-color: var(--brand-gold);
    color: #0A0A0A;
}

.btn-secondary {
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border-default);
    border-radius: 6px;
    padding: 8px 14px;
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 13px;
    transition: border-color 180ms ease, background-color 180ms ease;
    cursor: pointer;
}

.btn-secondary:hover {
    border-color: var(--text-primary);
}

.btn-ghost {
    background: transparent;
    color: var(--text-secondary);
    border: 0;
    padding: 6px 10px;
    font-family: var(--font-display);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    border-radius: 6px;
    transition: background-color 160ms ease, color 160ms ease;
}

.btn-ghost:hover {
    background: var(--bg-muted);
    color: var(--text-primary);
}

.input-base {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    color: var(--text-primary);
    border-radius: 6px;
    padding: 9px 12px;
    font-family: var(--font-body);
    font-size: 13px;
    width: 100%;
    transition: border-color 160ms ease, box-shadow 160ms ease;
}

.input-base:focus {
    outline: none;
    border-color: var(--brand-gold);
    box-shadow: 0 0 0 3px rgba(203, 161, 53, 0.18);
}

.row-hover:hover {
    background: var(--bg-muted);
}

.scrollbar-thin::-webkit-scrollbar {
    height: 10px;
    width: 10px;
}

.scrollbar-thin::-webkit-scrollbar-thumb {
    background: var(--border-strong);
    border-radius: 6px;
}

.scrollbar-thin::-webkit-scrollbar-track {
    background: transparent;
}

/* Kanban */
.kanban-col {
    background: var(--bg-muted);
    border-radius: 8px;
    width: 320px;
    min-width: 320px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: calc(100vh - 220px);
}

.kanban-card {
    background: #fff;
    border: 1px solid var(--border-default);
    border-radius: 8px;
    padding: 12px;
    cursor: grab;
    transition: transform 160ms ease, box-shadow 160ms ease,
        border-color 160ms ease;
}

.kanban-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 24px -12px rgba(0, 0, 0, 0.18);
    border-color: var(--text-primary);
}

.kanban-card.dragging {
    opacity: 0.4;
    cursor: grabbing;
}

.kanban-col.drag-over {
    background: var(--brand-gold-soft);
    outline: 2px dashed var(--brand-gold);
    outline-offset: -8px;
}

/* Leaflet tweaks */
.leaflet-container {
    background: var(--bg-muted) !important;
    font-family: var(--font-body) !important;
}

.leaflet-popup-content-wrapper {
    border-radius: 8px !important;
    border: 1px solid var(--border-default) !important;
}

.leaflet-popup-tip {
    background: #fff !important;
}

/* Sidebar active indicator */
.sidebar-link {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    color: var(--text-secondary);
    font-family: var(--font-display);
    font-weight: 500;
    font-size: 13px;
    border-radius: 6px;
    text-decoration: none;
    transition: color 160ms ease, background-color 160ms ease;
}

.sidebar-link:hover {
    color: var(--text-primary);
    background: var(--bg-muted);
}

.sidebar-link.active {
    color: var(--text-primary);
    background: var(--bg-muted);
    font-weight: 700;
}

.sidebar-link.active::before {
    content: "";
    position: absolute;
    left: -1px;
    top: 6px;
    bottom: 6px;
    width: 3px;
    border-radius: 0 3px 3px 0;
    background: var(--brand-gold);
}

/* Animations */
@keyframes fadeUp {
    from {
        opacity: 0;
        transform: translateY(6px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

.fade-up {
    animation: fadeUp 320ms ease both;
}

.delay-1 {
    animation-delay: 60ms;
}
.delay-2 {
    animation-delay: 120ms;
}
.delay-3 {
    animation-delay: 180ms;
}
.delay-4 {
    animation-delay: 240ms;
}

/* Prose for AI brief */
.brief-prose {
    font-family: var(--font-body);
    font-size: 14px;
    line-height: 1.7;
    color: var(--text-primary);
}

.brief-prose h3 {
    font-family: var(--font-display);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin: 24px 0 8px;
    color: var(--text-primary);
    border-left: 3px solid var(--brand-gold);
    padding-left: 10px;
}

.brief-prose ul {
    padding-left: 18px;
    margin: 8px 0 16px;
}

.brief-prose li {
    margin-bottom: 4px;
}

.brief-prose p {
    margin: 6px 0 14px;
}

.brief-prose strong {
    color: var(--text-primary);
    font-weight: 600;
}
```


## `frontend/src/App.css`

```css
/* App-level container only — global theme lives in index.css */
.App {
    min-height: 100vh;
    background: var(--bg-page);
}
```


## `frontend/src/lib/api.js`

```jsx
import axios from "axios";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API_BASE = `${BACKEND_URL}/api`;

export const api = axios.create({
  baseURL: API_BASE,
  headers: { "Content-Type": "application/json" },
  withCredentials: true,
});

export const PIPELINE_STATUSES = [
  "Identifierad",
  "Kontaktad",
  "Möte bokat",
  "Förhandling",
  "Signerad",
  "Onboardad",
];

export const STATUS_TONE = {
  Identifierad: { bg: "#F4F4F5", fg: "#52525B", dot: "#A1A1AA" },
  Kontaktad: { bg: "#FEF9C3", fg: "#854D0E", dot: "#EAB308" },
  "Möte bokat": { bg: "#FEF08A", fg: "#713F12", dot: "#CA8A04" },
  Förhandling: { bg: "#FAF3E1", fg: "#7C5A0F", dot: "#CBA135" },
  Signerad: { bg: "#DCFCE7", fg: "#14532D", dot: "#22C55E" },
  Onboardad: { bg: "#0A0A0A", fg: "#FFFFFF", dot: "#CBA135" },
};

export const PROSPECT_SOURCES = [
  "LinkedIn",
  "Rekommendation",
  "Event/Mässa",
  "Webbformulär",
  "Cold outreach",
  "Hemnet/Booli",
  "Scrape",
  "Annat",
];

export const COMPETITOR_AGENCIES = [
  "Fastighetsbyrån",
  "Svensk Fastighetsförmedling",
  "Länsförsäkringar Fastighetsförmedling",
  "HusmanHagberg",
  "ERA",
  "Mäklarhuset",
  "Bjurfors",
  "Notar",
  "Erik Olsson Fastighetsförmedling",
  "Mäklarringen",
  "Egen byrå",
  "Annan",
];

export const daysSince = (iso) => {
  if (!iso) return 0;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
};

export const formatNumber = (n) =>
  typeof n === "number" ? new Intl.NumberFormat("sv-SE").format(n) : n;

export const formatDate = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("sv-SE", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
};

export const formatDateTime = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("sv-SE", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
};

export const downloadCsv = async (endpoint, filename) => {
  const res = await api.get(endpoint, { responseType: "blob" });
  const blob = new Blob([res.data], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
```


## `frontend/src/lib/auth.jsx`

```jsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { api } from "./api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // null = checking; false = anonymous; object = logged in
  const [user, setUser] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get("/auth/me");
      setUser(res.data);
      return res.data;
    } catch (e) {
      setUser(false);
      return null;
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = async (email, password) => {
    const res = await api.post("/auth/login", { email, password });
    setUser(res.data.user);
    return res.data.user;
  };

  const logout = async () => {
    try {
      await api.post("/auth/logout");
    } catch {}
    setUser(false);
  };

  return (
    <AuthContext.Provider value={{ user, login, logout, refresh, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function formatApiError(detail) {
  if (detail == null) return "Något gick fel. Försök igen.";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail))
    return detail
      .map((e) => (e && typeof e.msg === "string" ? e.msg : JSON.stringify(e)))
      .filter(Boolean)
      .join(" ");
  if (detail && typeof detail.msg === "string") return detail.msg;
  return String(detail);
}
```


## `frontend/src/lib/utils.js`

```jsx
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
```


## `frontend/src/hooks/use-toast.js`

```jsx
"use client";
// Inspired by react-hot-toast library
import * as React from "react"

const TOAST_LIMIT = 1
const TOAST_REMOVE_DELAY = 1000000

const actionTypes = {
  ADD_TOAST: "ADD_TOAST",
  UPDATE_TOAST: "UPDATE_TOAST",
  DISMISS_TOAST: "DISMISS_TOAST",
  REMOVE_TOAST: "REMOVE_TOAST"
}

let count = 0

function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER
  return count.toString();
}

const toastTimeouts = new Map()

const addToRemoveQueue = (toastId) => {
  if (toastTimeouts.has(toastId)) {
    return
  }

  const timeout = setTimeout(() => {
    toastTimeouts.delete(toastId)
    dispatch({
      type: "REMOVE_TOAST",
      toastId: toastId,
    })
  }, TOAST_REMOVE_DELAY)

  toastTimeouts.set(toastId, timeout)
}

export const reducer = (state, action) => {
  switch (action.type) {
    case "ADD_TOAST":
      return {
        ...state,
        toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT),
      };

    case "UPDATE_TOAST":
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === action.toast.id ? { ...t, ...action.toast } : t),
      };

    case "DISMISS_TOAST": {
      const { toastId } = action

      // ! Side effects ! - This could be extracted into a dismissToast() action,
      // but I'll keep it here for simplicity
      if (toastId) {
        addToRemoveQueue(toastId)
      } else {
        state.toasts.forEach((toast) => {
          addToRemoveQueue(toast.id)
        })
      }

      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === toastId || toastId === undefined
            ? {
                ...t,
                open: false,
              }
            : t),
      };
    }
    case "REMOVE_TOAST":
      if (action.toastId === undefined) {
        return {
          ...state,
          toasts: [],
        }
      }
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.toastId),
      };
  }
}

const listeners = []

let memoryState = { toasts: [] }

function dispatch(action) {
  memoryState = reducer(memoryState, action)
  listeners.forEach((listener) => {
    listener(memoryState)
  })
}

function toast({
  ...props
}) {
  const id = genId()

  const update = (props) =>
    dispatch({
      type: "UPDATE_TOAST",
      toast: { ...props, id },
    })
  const dismiss = () => dispatch({ type: "DISMISS_TOAST", toastId: id })

  dispatch({
    type: "ADD_TOAST",
    toast: {
      ...props,
      id,
      open: true,
      onOpenChange: (open) => {
        if (!open) dismiss()
      },
    },
  })

  return {
    id: id,
    dismiss,
    update,
  }
}

function useToast() {
  const [state, setState] = React.useState(memoryState)

  React.useEffect(() => {
    listeners.push(setState)
    return () => {
      const index = listeners.indexOf(setState)
      if (index > -1) {
        listeners.splice(index, 1)
      }
    };
  }, [state])

  return {
    ...state,
    toast,
    dismiss: (toastId) => dispatch({ type: "DISMISS_TOAST", toastId }),
  };
}

export { useToast, toast }
```


## Frontend — Components

### `frontend/src/components/ActivityFeed.jsx`

```jsx
import {
  Sparkle,
  ArrowsLeftRight,
  Robot,
  EnvelopeSimple,
  PlusCircle,
  Trash,
  ArrowsClockwise,
} from "@phosphor-icons/react";
import { formatDateTime } from "../lib/api";

const ICONS = {
  status_change: ArrowsLeftRight,
  created: PlusCircle,
  deleted: Trash,
  ai_brief: Robot,
  reminder: EnvelopeSimple,
  scrape: ArrowsClockwise,
  assigned: Sparkle,
  user_created: Sparkle,
  user_updated: Sparkle,
  user_deleted: Sparkle,
};

export default function ActivityFeed({ items = [] }) {
  if (!items.length) {
    return (
      <div className="text-[13px] text-[#52525B] py-8 text-center" data-testid="activity-empty">
        Ingen aktivitet ännu.
      </div>
    );
  }
  return (
    <ul className="flex flex-col" data-testid="activity-feed">
      {items.map((a, idx) => {
        const Icon = ICONS[a.kind] || Sparkle;
        return (
          <li
            key={a.id}
            data-testid={`activity-item-${idx}`}
            className="flex items-start gap-3 py-3 border-b border-[#E5E5E5] last:border-0"
          >
            <div className="mt-0.5 w-7 h-7 rounded-md bg-[#FAFAFA] border border-[#E5E5E5] flex items-center justify-center shrink-0">
              <Icon size={14} color="#52525B" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] text-[#0A0A0A] font-body">{a.message}</div>
              <div className="text-[11px] text-[#A1A1AA] font-display font-semibold uppercase tracking-wider mt-0.5 flex items-center gap-1.5">
                <span>{formatDateTime(a.created_at)}</span>
                {a.actor_name && (
                  <>
                    <span className="text-[#D4D4D8]">·</span>
                    <span className="text-[#52525B]">{a.actor_name}</span>
                  </>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
```


### `frontend/src/components/DiscoverySheet.jsx`

```jsx
import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet";
import {
  ArrowSquareOut,
  Buildings,
  Database,
  MagnifyingGlass,
  Sparkle,
  PlusCircle,
} from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../lib/api";

function renderMarkdown(md) {
  if (!md) return null;
  const lines = md.split(/\r?\n/);
  const out = [];
  let listBuf = [];
  let orderedBuf = [];
  const flush = () => {
    if (listBuf.length) {
      out.push(`<ul>${listBuf.map((l) => `<li>${l}</li>`).join("")}</ul>`);
      listBuf = [];
    }
    if (orderedBuf.length) {
      out.push(`<ol>${orderedBuf.map((l) => `<li>${l}</li>`).join("")}</ol>`);
      orderedBuf = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("### ")) {
      flush();
      out.push(`<h3>${line.slice(4)}</h3>`);
    } else if (/^\d+\.\s/.test(line)) {
      orderedBuf.push(
        line.replace(/^\d+\.\s/, "").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      );
    } else if (line.startsWith("- ") || line.startsWith("• ")) {
      listBuf.push(line.slice(2).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"));
    } else if (line === "") {
      flush();
    } else {
      flush();
      out.push(`<p>${line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`);
    }
  }
  flush();
  return out.join("");
}

const ICONS = { Buildings, Database, MagnifyingGlass };

export default function DiscoverySheet({ city, open, onOpenChange }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [strategy, setStrategy] = useState("");
  const [loading, setLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);

  useEffect(() => {
    if (!open || !city) {
      setData(null);
      setStrategy("");
      return;
    }
    setLoading(true);
    api.get(`/discovery/${encodeURIComponent(city)}`)
      .then((res) => setData(res.data))
      .catch((e) => toast.error("Kunde inte hämta länkar: " + e.message))
      .finally(() => setLoading(false));
  }, [open, city]);

  const runAi = async () => {
    setAiLoading(true);
    try {
      const res = await api.post(`/discovery/${encodeURIComponent(city)}/ai-strategy`);
      setStrategy(res.data.strategy);
      toast.success("AI-strategi klar");
    } catch (e) {
      toast.error("AI-fel: " + (e.response?.data?.detail || e.message));
    } finally {
      setAiLoading(false);
    }
  };

  const createProspect = async () => {
    let officeId = "";
    try {
      const res = await api.get("/offices", { params: { city } });
      const match = (res.data.items || []).find(
        (o) => (o.city || "").toLowerCase() === city.toLowerCase()
      );
      if (match) officeId = match.id;
    } catch {}
    navigate("/pipeline", {
      state: {
        prefill: {
          city,
          region: data?.meta?.region || "",
          type: "office",
          source: "Annat",
          office_id: officeId,
        },
      },
    });
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[680px] overflow-y-auto bg-white border-l border-[#E5E5E5] p-0"
        data-testid="discovery-sheet"
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b border-[#E5E5E5]">
          <div className="overline">Lead discovery</div>
          <SheetTitle className="font-display font-extrabold tracking-tight text-3xl text-[#0A0A0A]">
            {city}
          </SheetTitle>
          <SheetDescription className="font-body text-sm text-[#52525B] mt-1">
            {data?.meta?.region}
            {data?.meta?.population
              ? ` · ${new Intl.NumberFormat("sv-SE").format(data.meta.population)} invånare · ~${new Intl.NumberFormat("sv-SE").format(data.meta.transactions)} bostadstransaktioner/år`
              : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="px-6 py-6 flex flex-col gap-6">
          {loading && (
            <div className="text-sm text-[#52525B]">Laddar länkar…</div>
          )}

          {data && (
            <>
              {/* AI Strategy block */}
              <section className="card-surface p-5">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="overline">AI Lead-discovery-strategi</div>
                    <div className="text-[13px] text-[#52525B] mt-1 font-body">
                      Konkret aktionsplan för {city}: kandidat-arketyper, sökstrategier, värvningsvinklar.
                    </div>
                  </div>
                  <button
                    data-testid="generate-strategy-btn"
                    onClick={runAi}
                    disabled={aiLoading}
                    className="btn-primary inline-flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <Sparkle size={14} weight="duotone" />
                    {aiLoading ? "Tänker…" : strategy ? "Generera om" : "Generera"}
                  </button>
                </div>
                {strategy ? (
                  <div
                    className="brief-prose mt-3"
                    data-testid="strategy-content"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(strategy) }}
                  />
                ) : (
                  <div className="text-sm text-[#A1A1AA] py-6 text-center border border-dashed border-[#E5E5E5] rounded-md">
                    Tryck "Generera" för en skräddarsydd strategi (Claude Sonnet).
                  </div>
                )}
              </section>

              {/* Direct links */}
              {data.groups.map((g) => {
                const Icon = ICONS[g.icon] || MagnifyingGlass;
                return (
                  <section key={g.label} data-testid={`link-group-${g.label}`}>
                    <div className="flex items-center gap-2 mb-3">
                      <Icon size={16} color="#CBA135" weight="duotone" />
                      <div className="font-display font-extrabold tracking-tight text-sm uppercase letter-spacing-wide text-[#0A0A0A]">
                        {g.label}
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {g.items.map((it) => (
                        <a
                          key={it.url}
                          href={it.url}
                          target="_blank"
                          rel="noreferrer"
                          data-testid={`discovery-link-${it.label}`}
                          className="card-surface p-3 flex items-center justify-between gap-2 hover:border-[#CBA135] transition-colors group"
                        >
                          <span className="font-display font-bold text-[13px] text-[#0A0A0A] truncate">
                            {it.label}
                          </span>
                          <ArrowSquareOut
                            size={14}
                            weight="bold"
                            className="text-[#A1A1AA] group-hover:text-[#CBA135] shrink-0"
                          />
                        </a>
                      ))}
                    </div>
                  </section>
                );
              })}

              {/* Quick add prospect */}
              <section className="card-surface p-5 border border-[#E5E5E5] bg-[#FAF3E1]">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="font-display font-extrabold text-[15px] text-[#0A0A0A]">
                      Hittat en kandidat?
                    </div>
                    <div className="text-[12px] text-[#52525B] font-body mt-0.5">
                      Skapa ett prospekt med {city} förifyllt så har du namnet i pipelinen.
                    </div>
                  </div>
                  <button
                    data-testid="create-prospect-from-city"
                    onClick={createProspect}
                    className="btn-primary inline-flex items-center gap-1.5"
                  >
                    <PlusCircle size={14} weight="duotone" /> Skapa prospekt
                  </button>
                </div>
              </section>

              <p className="text-[11px] text-[#A1A1AA] font-body">
                ⚠ Lagring av personuppgifter om mäklare kräver dokumenterad rättslig grund
                (vanligen berättigat intresse). Spara endast det du faktiskt behöver för värvning.
              </p>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
```


### `frontend/src/components/KpiCard.jsx`

```jsx
import { TrendUp, TrendDown } from "@phosphor-icons/react";
import { formatNumber } from "../lib/api";

export default function KpiCard({ label, value, sub, delta, accent = false, testId }) {
  return (
    <div
      data-testid={testId || "kpi-card"}
      className="card-surface p-6 flex flex-col gap-1 fade-up"
      style={accent ? { borderColor: "#0A0A0A" } : {}}
    >
      <div className="overline">{label}</div>
      <div className="mt-2 flex items-baseline gap-3">
        <div className="font-display font-extrabold tracking-tighter text-[#0A0A0A] text-4xl">
          {typeof value === "number" ? formatNumber(value) : value}
        </div>
        {typeof delta === "number" && (
          <div
            className={`flex items-center gap-1 text-xs font-display font-semibold ${
              delta >= 0 ? "text-[#16A34A]" : "text-[#DC2626]"
            }`}
          >
            {delta >= 0 ? <TrendUp size={13} /> : <TrendDown size={13} />}
            {Math.abs(delta)}%
          </div>
        )}
      </div>
      {sub && (
        <div className="text-[12px] text-[#52525B] mt-1 font-body">{sub}</div>
      )}
    </div>
  );
}
```


### `frontend/src/components/Layout.jsx`

```jsx
import { useState } from "react";
import { List, X } from "@phosphor-icons/react";
import { NavLink } from "react-router-dom";
import Sidebar from "./Sidebar";

const mobileLinks = [
  { to: "/", label: "Översikt", end: true },
  { to: "/pipeline", label: "Pipeline" },
  { to: "/lost", label: "Förlorade" },
  { to: "/offices", label: "Kontor" },
  { to: "/brokers", label: "Mäklare" },
  { to: "/map", label: "Karta" },
  { to: "/scrape", label: "Scraping" },
  { to: "/settings", label: "Inställningar" },
  { to: "/team", label: "Mitt team" },
];

export default function Layout({ children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-screen bg-[#FAFAFA]">
      <Sidebar />

      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-40 bg-white border-b border-[#E5E5E5] px-4 py-3 flex items-center justify-between">
        <div className="font-display font-extrabold tracking-tight">
          Etablering · <span className="text-[#CBA135]">Skandia</span>
        </div>
        <button
          data-testid="mobile-menu-toggle"
          onClick={() => setOpen((v) => !v)}
          className="btn-ghost"
        >
          {open ? <X size={20} /> : <List size={20} />}
        </button>
      </div>

      {open && (
        <div className="md:hidden fixed inset-0 z-30 bg-black/40" onClick={() => setOpen(false)}>
          <div
            className="absolute top-[56px] left-0 right-0 bg-white border-b border-[#E5E5E5] py-2 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {mobileLinks.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.end}
                onClick={() => setOpen(false)}
                data-testid={`mobile-nav-${l.to.replace("/", "") || "home"}`}
                className={({ isActive }) =>
                  `px-5 py-3 text-sm font-display font-semibold ${
                    isActive ? "text-[#0A0A0A] bg-[#F4F4F5]" : "text-[#52525B]"
                  }`
                }
              >
                {l.label}
              </NavLink>
            ))}
          </div>
        </div>
      )}

      <main className="flex-1 min-w-0 pt-[60px] md:pt-0">
        <div className="max-w-[1600px] mx-auto px-4 md:px-10 py-6 md:py-10">
          {children}
        </div>
      </main>
    </div>
  );
}
```


### `frontend/src/components/ProspectSheet.jsx`

```jsx
import { useEffect, useRef, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Textarea } from "../components/ui/textarea";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  Sparkle,
  EnvelopeSimple,
  Trash,
  FloppyDisk,
  Phone,
  LinkedinLogo,
  XCircle,
  ArrowCounterClockwise,
  CurrencyCircleDollar,
  PaperclipHorizontal,
  CheckCircle,
  Circle,
  CloudArrowUp,
  Plus,
  MapPin,
  Calendar,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, PIPELINE_STATUSES, PROSPECT_SOURCES, COMPETITOR_AGENCIES } from "../lib/api";
import StatusPill from "./StatusPill";

function renderMarkdown(md) {
  if (!md) return null;
  // Minimal markdown → HTML for AI brief: ### headings, **bold**, - lists
  const lines = md.split(/\r?\n/);
  const out = [];
  let listBuf = [];
  const flushList = () => {
    if (listBuf.length) {
      out.push(`<ul>${listBuf.map((l) => `<li>${l}</li>`).join("")}</ul>`);
      listBuf = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("### ")) {
      flushList();
      out.push(`<h3>${line.slice(4)}</h3>`);
    } else if (line.startsWith("- ") || line.startsWith("• ")) {
      listBuf.push(
        line.slice(2).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      );
    } else if (line === "") {
      flushList();
    } else {
      flushList();
      out.push(`<p>${line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`);
    }
  }
  flushList();
  return out.join("");
}

export default function ProspectSheet({ prospect, users = [], offices = [], open, onOpenChange, onUpdated, onDeleted }) {
  const [form, setForm] = useState(prospect || {});
  const [saving, setSaving] = useState(false);
  const [briefLoading, setBriefLoading] = useState(false);
  const [emailLoading, setEmailLoading] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [lostDialogOpen, setLostDialogOpen] = useState(false);
  const [lostAgency, setLostAgency] = useState(COMPETITOR_AGENCIES[0]);
  const [lostReason, setLostReason] = useState("");
  const [lostBusy, setLostBusy] = useState(false);

  // Phase 3 — Files
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  // Phase 3 — Onboarding
  const [onboarding, setOnboarding] = useState([]);
  const [onboardingBusy, setOnboardingBusy] = useState(false);

  useEffect(() => {
    if (!prospect?.id) return;
    api.get(`/prospects/${prospect.id}/files`)
      .then((res) => setFiles(res.data.items || []))
      .catch(() => setFiles([]));
    api.get(`/prospects/${prospect.id}/onboarding`)
      .then((res) => setOnboarding(res.data.items || []))
      .catch(() => setOnboarding([]));
  }, [prospect?.id]);

  // Sync when prospect changes
  if (prospect && prospect.id !== form.id) {
    setForm(prospect);
  }

  if (!prospect) return null;

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.patch(`/prospects/${prospect.id}`, {
        name: form.name,
        type: form.type,
        current_agency: form.current_agency,
        city: form.city,
        region: form.region,
        phone: form.phone,
        email: form.email,
        linkedin: form.linkedin,
        status: form.status,
        notes: form.notes,
        next_step: form.next_step,
        next_step_date: form.next_step_date,
        owner_id: form.owner_id || "",
        office_id: form.office_id || "",
        source: form.source || "Annat",
        source_detail: form.source_detail || "",
        referred_by: form.referred_by || "",
        signing_bonus: form.signing_bonus === "" ? null : Number(form.signing_bonus) || null,
        commission_split: form.commission_split || "",
        guaranteed_salary: form.guaranteed_salary === "" ? null : Number(form.guaranteed_salary) || null,
        establishment_grant: form.establishment_grant === "" ? null : Number(form.establishment_grant) || null,
        start_date: form.start_date || null,
        contract_term_months: form.contract_term_months === "" ? null : Number(form.contract_term_months) || null,
        expected_first_year_revenue: form.expected_first_year_revenue === "" ? null : Number(form.expected_first_year_revenue) || null,
        economy_notes: form.economy_notes || "",
      });
      toast.success("Prospekt uppdaterat");
      onUpdated?.(res.data);
      setForm(res.data);
    } catch (e) {
      toast.error("Kunde inte spara: " + (e.response?.data?.detail || e.message));
    } finally {
      setSaving(false);
    }
  };

  const uploadFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await api.post(`/prospects/${prospect.id}/files`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setFiles((cur) => [res.data, ...cur]);
      toast.success(`${f.name} uppladdad`);
    } catch (err) {
      toast.error("Uppladdning misslyckades: " + (err.response?.data?.detail || err.message));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const downloadFile = async (file) => {
    try {
      const res = await api.get(`/files/${file.id}/download`, { responseType: "blob" });
      const url = URL.createObjectURL(new Blob([res.data], { type: file.content_type }));
      const link = document.createElement("a");
      link.href = url;
      link.download = file.original_filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast.error("Nedladdning misslyckades: " + e.message);
    }
  };

  const deleteFile = async (file) => {
    if (!confirm(`Ta bort ${file.original_filename}?`)) return;
    try {
      await api.delete(`/files/${file.id}`);
      setFiles((cur) => cur.filter((x) => x.id !== file.id));
      toast.success("Fil borttagen");
    } catch (e) {
      toast.error("Kunde inte ta bort: " + e.message);
    }
  };

  const initOnboarding = async () => {
    setOnboardingBusy(true);
    try {
      const res = await api.post(`/prospects/${prospect.id}/onboarding/init`);
      setOnboarding(res.data.items || []);
      toast.success("Onboarding-checklista skapad");
    } catch (e) {
      toast.error("Fel: " + e.message);
    } finally {
      setOnboardingBusy(false);
    }
  };

  const toggleOnboarding = async (item) => {
    try {
      const res = await api.patch(`/onboarding/${item.id}`, { completed: !item.completed });
      setOnboarding((cur) => cur.map((x) => (x.id === item.id ? res.data : x)));
    } catch (e) {
      toast.error("Fel: " + e.message);
    }
  };

  const markLost = async () => {
    if (!lostAgency.trim()) {
      toast.error("Välj kedja");
      return;
    }
    setLostBusy(true);
    try {
      const res = await api.post(`/prospects/${prospect.id}/lost`, {
        lost_to_agency: lostAgency,
        lost_reason: lostReason,
      });
      toast.success(`Markerad som förlorad till ${lostAgency}`);
      setForm(res.data);
      onUpdated?.(res.data);
      setLostDialogOpen(false);
      setLostReason("");
    } catch (e) {
      toast.error("Kunde inte markera: " + (e.response?.data?.detail || e.message));
    } finally {
      setLostBusy(false);
    }
  };

  const restore = async () => {
    if (!confirm(`Återställ ${form.name} till pipeline?`)) return;
    try {
      const res = await api.post(`/prospects/${prospect.id}/restore`);
      toast.success("Prospektet är tillbaka i pipelinen");
      setForm(res.data);
      onUpdated?.(res.data);
    } catch (e) {
      toast.error("Kunde inte återställa: " + (e.response?.data?.detail || e.message));
    }
  };

  const deleteProspect = async () => {
    if (!confirm(`Ta bort prospekt "${prospect.name}"?`)) return;
    try {
      await api.delete(`/prospects/${prospect.id}`);
      toast.success("Prospekt borttaget");
      onDeleted?.(prospect.id);
      onOpenChange(false);
    } catch (e) {
      toast.error("Kunde inte ta bort: " + e.message);
    }
  };

  const runBrief = async () => {
    setBriefLoading(true);
    try {
      const res = await api.post("/ai/research-brief", {
        prospect_id: prospect.id,
        name: form.name,
        city: form.city,
        current_agency: form.current_agency,
        notes: form.notes,
      });
      const updated = { ...form, ai_brief: res.data.brief };
      setForm(updated);
      onUpdated?.(updated);
      toast.success("AI-research klar");
    } catch (e) {
      toast.error("AI-fel: " + (e.response?.data?.detail || e.message));
    } finally {
      setBriefLoading(false);
    }
  };

  const sendReminder = async () => {
    setEmailLoading(true);
    try {
      const res = await api.post("/reminders/send", {
        prospect_id: prospect.id,
        recipient: recipient || undefined,
      });
      if (res.data.status === "success") {
        toast.success(res.data.message);
      } else if (res.data.status === "skipped") {
        toast.warning(res.data.message);
      } else {
        toast.error(res.data.message);
      }
    } catch (e) {
      toast.error("Kunde inte skicka: " + e.message);
    } finally {
      setEmailLoading(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[640px] overflow-y-auto bg-white border-l border-[#E5E5E5] p-0"
        data-testid="prospect-sheet"
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b border-[#E5E5E5]">
          <div className="overline">Värvningsprospekt</div>
          <SheetTitle className="font-display font-extrabold tracking-tight text-2xl text-[#0A0A0A]">
            {form.name}
          </SheetTitle>
          <SheetDescription className="sr-only">
            Redigera prospektet, generera AI-research, eller skicka en e-postpåminnelse.
          </SheetDescription>
          <div className="flex items-center gap-2 pt-1 flex-wrap">
            <StatusPill status={form.status} size="lg" />
            {form.city && (
              <span className="inline-flex items-center gap-1 text-xs text-[#52525B] font-body">
                <MapPin size={12} /> {form.city}
              </span>
            )}
            {form.current_agency && (
              <span className="text-xs text-[#52525B] font-body">· {form.current_agency}</span>
            )}
          </div>
        </SheetHeader>

        <div className="px-6 py-6 flex flex-col gap-6">
          {/* AI brief block */}
          <section className="card-surface p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="overline">AI Research-brief</div>
                <div className="text-[13px] text-[#52525B] mt-1 font-body">
                  Genererad analys baserat på namn, ort och kedja.
                </div>
              </div>
              <button
                data-testid="generate-brief-btn"
                onClick={runBrief}
                disabled={briefLoading}
                className="btn-primary inline-flex items-center gap-1.5"
              >
                <Sparkle size={14} weight="duotone" />
                {briefLoading ? "Genererar…" : form.ai_brief ? "Generera om" : "Generera"}
              </button>
            </div>
            {form.ai_brief ? (
              <div
                className="brief-prose mt-4"
                data-testid="ai-brief-content"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(form.ai_brief) }}
              />
            ) : (
              <div className="text-sm text-[#A1A1AA] py-6 text-center border border-dashed border-[#E5E5E5] rounded-md">
                Ingen brief genererad ännu.
              </div>
            )}
          </section>

          {/* Form */}
          <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label className="overline">Namn</Label>
              <Input
                data-testid="prospect-name-input"
                className="input-base mt-1.5"
                value={form.name || ""}
                onChange={(e) => update("name", e.target.value)}
              />
            </div>
            <div>
              <Label className="overline">Status</Label>
              <Select value={form.status} onValueChange={(v) => update("status", v)}>
                <SelectTrigger data-testid="prospect-status-select" className="input-base mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PIPELINE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="overline">Nuvarande kedja</Label>
              <Input
                data-testid="prospect-agency-input"
                className="input-base mt-1.5"
                value={form.current_agency || ""}
                onChange={(e) => update("current_agency", e.target.value)}
              />
            </div>
            <div>
              <Label className="overline">Ort</Label>
              <Input
                data-testid="prospect-city-input"
                className="input-base mt-1.5"
                value={form.city || ""}
                onChange={(e) => update("city", e.target.value)}
              />
            </div>
            <div>
              <Label className="overline">Telefon</Label>
              <Input
                data-testid="prospect-phone-input"
                className="input-base mt-1.5"
                value={form.phone || ""}
                onChange={(e) => update("phone", e.target.value)}
              />
            </div>
            <div>
              <Label className="overline">E-post</Label>
              <Input
                data-testid="prospect-email-input"
                className="input-base mt-1.5"
                value={form.email || ""}
                onChange={(e) => update("email", e.target.value)}
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="overline">LinkedIn</Label>
              <Input
                data-testid="prospect-linkedin-input"
                className="input-base mt-1.5"
                value={form.linkedin || ""}
                onChange={(e) => update("linkedin", e.target.value)}
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="overline">Ansvarig</Label>
              <Select
                value={form.owner_id || "__none__"}
                onValueChange={(v) => update("owner_id", v === "__none__" ? "" : v)}
              >
                <SelectTrigger data-testid="prospect-owner-select" className="input-base mt-1.5">
                  <SelectValue placeholder="Otilldelad" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Otilldelad</SelectItem>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.name} {u.role === "admin" ? "· admin" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="overline">Källa</Label>
              <Select
                value={form.source || "Annat"}
                onValueChange={(v) => update("source", v)}
              >
                <SelectTrigger data-testid="prospect-source-select" className="input-base mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROSPECT_SOURCES.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="overline">Referent / detalj</Label>
              <Input
                data-testid="prospect-referred-by-input"
                className="input-base mt-1.5"
                placeholder="t.ex. Pia Hansson eller Mäklarmässan -25"
                value={form.referred_by || form.source_detail || ""}
                onChange={(e) => update("referred_by", e.target.value)}
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="overline">Kontor (värvningsmål)</Label>
              <Select
                value={form.office_id || "__none__"}
                onValueChange={(v) => update("office_id", v === "__none__" ? "" : v)}
              >
                <SelectTrigger data-testid="prospect-office-select" className="input-base mt-1.5">
                  <SelectValue placeholder="Inget specifikt kontor" />
                </SelectTrigger>
                <SelectContent className="max-h-[300px]">
                  <SelectItem value="__none__">— Inget specifikt kontor —</SelectItem>
                  {offices.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.name}{o.city ? ` · ${o.city}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.office_name && (
                <p className="text-[11px] text-[#A1A1AA] mt-1 font-body">
                  Kopplad till <strong className="text-[#CBA135] font-display">{form.office_name}</strong> — räknas mot kontorets rekryteringsmål.
                </p>
              )}
            </div>
            <div>
              <Label className="overline">Nästa steg</Label>
              <Input
                data-testid="prospect-next-step-input"
                className="input-base mt-1.5"
                placeholder="t.ex. Lunchmöte"
                value={form.next_step || ""}
                onChange={(e) => update("next_step", e.target.value)}
              />
            </div>
            <div>
              <Label className="overline">Datum</Label>
              <Input
                type="date"
                data-testid="prospect-next-date-input"
                className="input-base mt-1.5"
                value={(form.next_step_date || "").slice(0, 10)}
                onChange={(e) => update("next_step_date", e.target.value)}
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="overline">Anteckningar</Label>
              <Textarea
                data-testid="prospect-notes-input"
                className="input-base mt-1.5 min-h-[120px] font-body"
                value={form.notes || ""}
                onChange={(e) => update("notes", e.target.value)}
              />
            </div>
          </section>

          {/* Reminder */}
          <section className="card-surface p-5">
            <div className="flex items-center gap-2 mb-2">
              <EnvelopeSimple size={16} color="#CBA135" weight="duotone" />
              <div className="font-display font-bold text-sm">E-postpåminnelse</div>
            </div>
            <p className="text-[12px] text-[#52525B] font-body mb-3">
              Skickar en kort sammanfattning med nästa-steg-datum till mottagaradressen
              (Resend krävs i .env).
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                data-testid="reminder-recipient-input"
                placeholder="din@email.se (lämna tomt för REMINDER_RECIPIENT)"
                className="input-base flex-1"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              />
              <button
                data-testid="send-reminder-btn"
                onClick={sendReminder}
                disabled={emailLoading}
                className="btn-secondary inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <EnvelopeSimple size={14} /> {emailLoading ? "Skickar…" : "Skicka"}
              </button>
            </div>
          </section>

          {/* Anbudsekonomi */}
          <section className="card-surface p-5" data-testid="economy-section">
            <div className="flex items-center gap-2 mb-3">
              <CurrencyCircleDollar size={16} color="#CBA135" weight="duotone" />
              <div className="font-display font-bold text-sm">Anbudsekonomi</div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="overline">Signing bonus (SEK)</Label>
                <Input
                  data-testid="signing-bonus-input"
                  type="number"
                  className="input-base mt-1.5 tabular-nums"
                  value={form.signing_bonus ?? ""}
                  onChange={(e) => update("signing_bonus", e.target.value)}
                />
              </div>
              <div>
                <Label className="overline">Provisionsmodell</Label>
                <Input
                  data-testid="commission-split-input"
                  className="input-base mt-1.5"
                  placeholder="t.ex. 70/30 eller 50/50 + bonus"
                  value={form.commission_split || ""}
                  onChange={(e) => update("commission_split", e.target.value)}
                />
              </div>
              <div>
                <Label className="overline">Garantilön / månad (SEK)</Label>
                <Input
                  data-testid="guaranteed-salary-input"
                  type="number"
                  className="input-base mt-1.5 tabular-nums"
                  value={form.guaranteed_salary ?? ""}
                  onChange={(e) => update("guaranteed_salary", e.target.value)}
                />
              </div>
              <div>
                <Label className="overline">Etablerings-stöd (SEK)</Label>
                <Input
                  type="number"
                  className="input-base mt-1.5 tabular-nums"
                  value={form.establishment_grant ?? ""}
                  onChange={(e) => update("establishment_grant", e.target.value)}
                />
              </div>
              <div>
                <Label className="overline">Tillträde</Label>
                <Input
                  type="date"
                  className="input-base mt-1.5"
                  value={(form.start_date || "").slice(0, 10)}
                  onChange={(e) => update("start_date", e.target.value)}
                />
              </div>
              <div>
                <Label className="overline">Bindningstid (mån)</Label>
                <Input
                  type="number"
                  className="input-base mt-1.5 tabular-nums"
                  value={form.contract_term_months ?? ""}
                  onChange={(e) => update("contract_term_months", e.target.value)}
                />
              </div>
              <div className="sm:col-span-2">
                <Label className="overline">Förväntad intäkt år 1 (SEK)</Label>
                <Input
                  data-testid="expected-revenue-input"
                  type="number"
                  className="input-base mt-1.5 tabular-nums"
                  placeholder="0"
                  value={form.expected_first_year_revenue ?? ""}
                  onChange={(e) => update("expected_first_year_revenue", e.target.value)}
                />
              </div>
              <div className="sm:col-span-2">
                <Label className="overline">Ekonomi-anteckningar</Label>
                <Textarea
                  className="input-base mt-1.5 font-body"
                  rows={2}
                  value={form.economy_notes || ""}
                  onChange={(e) => update("economy_notes", e.target.value)}
                />
              </div>
            </div>
          </section>

          {/* Dokument */}
          <section className="card-surface p-5" data-testid="files-section">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <PaperclipHorizontal size={16} color="#CBA135" weight="duotone" />
                <div className="font-display font-bold text-sm">Dokument</div>
              </div>
              <label className="btn-secondary inline-flex items-center gap-1.5 cursor-pointer">
                <CloudArrowUp size={14} />
                {uploading ? "Laddar upp…" : "Ladda upp"}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.txt,.csv"
                  className="hidden"
                  onChange={uploadFile}
                  disabled={uploading}
                  data-testid="file-upload-input"
                />
              </label>
            </div>
            {files.length === 0 ? (
              <div className="text-sm text-[#A1A1AA] py-6 text-center border border-dashed border-[#E5E5E5] rounded-md font-body">
                Inga dokument än. LOI, avtal, NDA — PDF/DOCX/JPG max 15 MB.
              </div>
            ) : (
              <ul className="flex flex-col divide-y divide-[#E5E5E5]">
                {files.map((f) => (
                  <li
                    key={f.id}
                    data-testid={`file-row-${f.id}`}
                    className="py-2.5 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0 flex items-center gap-2">
                      <PaperclipHorizontal size={14} color="#52525B" />
                      <div className="min-w-0">
                        <div className="font-body text-[13px] text-[#0A0A0A] truncate">
                          {f.original_filename}
                        </div>
                        <div className="text-[11px] text-[#A1A1AA] font-display font-semibold uppercase tracking-wider">
                          {(f.size / 1024).toFixed(1)} KB · {f.uploaded_by_name}
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={() => downloadFile(f)}
                        data-testid={`download-${f.id}`}
                        className="btn-ghost text-xs"
                      >
                        Ladda ner
                      </button>
                      <button
                        onClick={() => deleteFile(f)}
                        data-testid={`delete-file-${f.id}`}
                        className="btn-ghost p-1.5 text-[#DC2626]"
                      >
                        <Trash size={12} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Onboarding */}
          <section className="card-surface p-5" data-testid="onboarding-section">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <CheckCircle size={16} color="#CBA135" weight="duotone" />
                <div className="font-display font-bold text-sm">
                  Onboarding ({onboarding.filter((i) => i.completed).length}/{onboarding.length})
                </div>
              </div>
              {onboarding.length === 0 && (
                <button
                  data-testid="init-onboarding-btn"
                  onClick={initOnboarding}
                  disabled={onboardingBusy}
                  className="btn-primary inline-flex items-center gap-1.5"
                >
                  <Plus size={14} /> {onboardingBusy ? "Skapar…" : "Starta 30/60/90"}
                </button>
              )}
            </div>
            {onboarding.length === 0 ? (
              <p className="text-[12px] text-[#52525B] font-body">
                Skapa en 11-stegs checklista med standard onboarding-aktiviteter
                (välkomstmejl, IT-access, mentor, 30/60/90-dagars check-ins).
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-[#E5E5E5]">
                {onboarding.map((it) => (
                  <li
                    key={it.id}
                    data-testid={`onboarding-${it.id}`}
                    className="py-2 flex items-start justify-between gap-3"
                  >
                    <button
                      onClick={() => toggleOnboarding(it)}
                      className="flex items-start gap-2 text-left flex-1 min-w-0"
                    >
                      {it.completed ? (
                        <CheckCircle size={16} color="#22C55E" weight="fill" className="mt-0.5 shrink-0" />
                      ) : (
                        <Circle size={16} color="#D4D4D8" className="mt-0.5 shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div
                          className={`text-[13px] font-body ${
                            it.completed ? "text-[#A1A1AA] line-through" : "text-[#0A0A0A]"
                          }`}
                        >
                          {it.title}
                        </div>
                        <div className="text-[11px] text-[#A1A1AA] font-display font-semibold uppercase tracking-wider mt-0.5">
                          Dag {it.due_offset_days}
                          {it.completed && it.completed_by_name && (
                            <> · klart av {it.completed_by_name}</>
                          )}
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="flex justify-between items-center pt-2 flex-wrap gap-2">
            <div className="flex gap-2">
              <button
                data-testid="delete-prospect-btn"
                onClick={deleteProspect}
                className="btn-ghost inline-flex items-center gap-1.5 text-[#DC2626] hover:text-[#DC2626]"
              >
                <Trash size={14} /> Ta bort
              </button>
              {form.is_lost ? (
                <button
                  data-testid="restore-prospect-btn"
                  onClick={restore}
                  className="btn-ghost inline-flex items-center gap-1.5"
                >
                  <ArrowCounterClockwise size={14} /> Återställ
                </button>
              ) : (
                <button
                  data-testid="mark-lost-btn"
                  onClick={() => setLostDialogOpen(true)}
                  className="btn-ghost inline-flex items-center gap-1.5 text-[#DC2626] hover:text-[#DC2626]"
                >
                  <XCircle size={14} /> Markera som förlorad
                </button>
              )}
            </div>
            <button
              data-testid="save-prospect-btn"
              onClick={save}
              disabled={saving}
              className="btn-primary inline-flex items-center gap-1.5"
            >
              <FloppyDisk size={14} /> {saving ? "Sparar…" : "Spara ändringar"}
            </button>
          </div>

          {form.is_lost && (
            <div
              data-testid="lost-banner"
              className="card-surface p-4 border border-[#FECACA] bg-[#FEF2F2]"
            >
              <div className="flex items-center gap-2 mb-1">
                <XCircle size={16} weight="duotone" color="#DC2626" />
                <div className="font-display font-extrabold text-[#7F1D1D] text-sm uppercase tracking-wider">
                  Förlorad till {form.lost_to_agency || "—"}
                </div>
              </div>
              {form.lost_reason && (
                <p className="text-[13px] text-[#7F1D1D] font-body">{form.lost_reason}</p>
              )}
              <p className="text-[11px] text-[#A33] font-display font-semibold uppercase tracking-wider mt-2">
                {form.lost_at ? new Date(form.lost_at).toLocaleString("sv-SE") : ""}
              </p>
            </div>
          )}

          {/* Contact quick links */}
          {(form.phone || form.email || form.linkedin) && (
            <div className="flex flex-wrap gap-2 pt-2">
              {form.phone && (
                <a href={`tel:${form.phone}`} className="btn-secondary inline-flex items-center gap-1.5 text-xs">
                  <Phone size={12} /> {form.phone}
                </a>
              )}
              {form.email && (
                <a href={`mailto:${form.email}`} className="btn-secondary inline-flex items-center gap-1.5 text-xs">
                  <EnvelopeSimple size={12} /> {form.email}
                </a>
              )}
              {form.linkedin && (
                <a href={form.linkedin} target="_blank" rel="noreferrer" className="btn-secondary inline-flex items-center gap-1.5 text-xs">
                  <LinkedinLogo size={12} /> LinkedIn
                </a>
              )}
            </div>
          )}

          {form.next_step_date && (
            <div className="text-xs text-[#52525B] flex items-center gap-1.5 font-body">
              <Calendar size={12} />
              Nästa steg: <strong className="text-[#0A0A0A]">{form.next_step}</strong> ·{" "}
              <span className="text-[#CBA135] font-display font-bold">
                {(form.next_step_date || "").slice(0, 10)}
              </span>
            </div>
          )}
        </div>
      </SheetContent>

      <Dialog open={lostDialogOpen} onOpenChange={setLostDialogOpen}>
        <DialogContent className="sm:max-w-[480px] bg-white" data-testid="lost-dialog">
          <DialogHeader>
            <div className="overline">Markera som förlorad</div>
            <DialogTitle className="font-display font-extrabold tracking-tight text-2xl">
              Vart gick {form.name}?
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 mt-2">
            <div>
              <Label className="overline">Konkurrent</Label>
              <Select value={lostAgency} onValueChange={setLostAgency}>
                <SelectTrigger data-testid="lost-agency-select" className="input-base mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMPETITOR_AGENCIES.map((a) => (
                    <SelectItem key={a} value={a}>{a}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="overline">Anledning (kort)</Label>
              <Textarea
                data-testid="lost-reason-input"
                placeholder="t.ex. bättre lön, närmare bostad, tackade ja till annat erbjudande"
                className="input-base mt-1 font-body"
                value={lostReason}
                onChange={(e) => setLostReason(e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setLostDialogOpen(false)} className="btn-ghost">
              Avbryt
            </button>
            <button
              data-testid="confirm-mark-lost"
              onClick={markLost}
              disabled={lostBusy}
              className="btn-primary inline-flex items-center gap-1.5"
            >
              <XCircle size={14} /> {lostBusy ? "Markerar…" : "Markera som förlorad"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </Sheet>
  );
}
```


### `frontend/src/components/Sidebar.jsx`

```jsx
import { NavLink } from "react-router-dom";
import {
  ChartBar,
  Kanban,
  Buildings,
  UsersThree,
  MapTrifold,
  GearSix,
  ArrowsClockwise,
  Compass,
  SignOut,
  UsersFour,
  XCircle,
} from "@phosphor-icons/react";
import { useAuth } from "../lib/auth";

const links = [
  { to: "/", label: "Översikt", icon: ChartBar, end: true, testId: "nav-dashboard" },
  { to: "/pipeline", label: "Pipeline", icon: Kanban, testId: "nav-pipeline" },
  { to: "/lost", label: "Förlorade", icon: XCircle, testId: "nav-lost" },
  { to: "/offices", label: "Kontor", icon: Buildings, testId: "nav-offices" },
  { to: "/brokers", label: "Mäklare", icon: UsersThree, testId: "nav-brokers" },
  { to: "/map", label: "Karta & White Spots", icon: MapTrifold, testId: "nav-map" },
  { to: "/scrape", label: "Scraping", icon: ArrowsClockwise, testId: "nav-scrape" },
  { to: "/settings", label: "Mål & Inställningar", icon: GearSix, testId: "nav-settings" },
  { to: "/team", label: "Mitt team", icon: UsersFour, testId: "nav-team" },
];

export default function Sidebar() {
  const { user, logout } = useAuth();
  return (
    <aside
      data-testid="sidebar"
      className="hidden md:flex flex-col w-64 shrink-0 bg-white border-r border-[#E5E5E5] h-screen sticky top-0"
    >
      <div className="px-6 pt-7 pb-6 border-b border-[#E5E5E5]">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-md bg-[#0A0A0A] flex items-center justify-center">
            <Compass size={18} weight="duotone" color="#CBA135" />
          </div>
          <div className="leading-tight">
            <div className="font-display font-extrabold tracking-tight text-[#0A0A0A] text-[15px]">
              Etablering
            </div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-[#A1A1AA] font-display font-semibold">
              Skandiamäklarna
            </div>
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 flex flex-col gap-0.5">
        <div className="overline px-3 pb-2 pt-1">Arbetsyta</div>
        {links.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            data-testid={l.testId}
            className={({ isActive }) =>
              `sidebar-link ${isActive ? "active" : ""}`
            }
          >
            <l.icon size={16} weight="regular" />
            <span>{l.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="px-5 py-4 border-t border-[#E5E5E5]">
        <div className="overline pb-1.5">Inloggad som</div>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div
              className="font-display font-bold text-[#0A0A0A] text-sm truncate"
              data-testid="sidebar-user-name"
            >
              {user?.name || "—"}
            </div>
            <div className="text-[12px] text-[#52525B] flex items-center gap-1.5">
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: user?.role === "admin" ? "#CBA135" : "#A1A1AA" }}
              />
              {user?.role === "admin" ? "Admin" : "Medlem"}
            </div>
          </div>
          <button
            data-testid="sidebar-logout"
            onClick={logout}
            title="Logga ut"
            className="btn-ghost p-1.5"
          >
            <SignOut size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
}
```


### `frontend/src/components/StatusPill.jsx`

```jsx
import { STATUS_TONE } from "../lib/api";

export default function StatusPill({ status, size = "sm", testId }) {
  const tone = STATUS_TONE[status] || STATUS_TONE.Identifierad;
  const padding = size === "lg" ? "px-3 py-1.5 text-[12px]" : "px-2 py-1 text-[11px]";
  return (
    <span
      data-testid={testId || `status-pill-${status}`}
      className={`inline-flex items-center gap-1.5 rounded-full font-display font-semibold ${padding}`}
      style={{ background: tone.bg, color: tone.fg }}
    >
      <span
        className="inline-block w-1.5 h-1.5 rounded-full"
        style={{ background: tone.dot }}
      />
      {status}
    </span>
  );
}
```


### `frontend/src/components/SwedenMap.jsx`

```jsx
import { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Tooltip, Popup } from "react-leaflet";
import { api } from "../lib/api";

const POSITRON =
  "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

export default function SwedenMap({ height = 520, mode = "all" }) {
  const [data, setData] = useState({ items: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api.get("/geo/municipalities").then((res) => {
      if (live) {
        setData(res.data);
        setLoading(false);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  const items = useMemo(() => {
    if (mode === "whitespots") return data.items.filter((m) => !m.has_skandia);
    if (mode === "covered") return data.items.filter((m) => m.has_skandia);
    return data.items;
  }, [data, mode]);

  return (
    <div
      data-testid="sweden-map"
      className="card-surface overflow-hidden relative"
      style={{ height }}
    >
      {loading && (
        <div className="absolute inset-0 z-[400] flex items-center justify-center bg-white/80 text-sm text-[#52525B]">
          Laddar karta…
        </div>
      )}
      <MapContainer
        center={[62.0, 16.0]}
        zoom={5}
        minZoom={4}
        maxZoom={10}
        scrollWheelZoom={true}
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer url={POSITRON} attribution={ATTRIBUTION} />
        {items.map((m) => {
          const covered = m.has_skandia;
          const radius = Math.max(6, Math.min(22, Math.sqrt(m.population) / 60));
          return (
            <CircleMarker
              key={m.name}
              center={[m.lat, m.lng]}
              radius={radius}
              pathOptions={{
                color: covered ? "#0A0A0A" : "#CBA135",
                fillColor: covered ? "#0A0A0A" : "#CBA135",
                fillOpacity: covered ? 0.85 : 0.25,
                weight: covered ? 1 : 2,
              }}
            >
              <Tooltip direction="top" offset={[0, -radius]}>
                <span className="font-display font-semibold">
                  {m.name} {covered ? "· Skandia" : "· White spot"}
                </span>
              </Tooltip>
              <Popup>
                <div className="text-sm font-body" style={{ minWidth: 200 }}>
                  <div className="font-display font-extrabold text-[15px] mb-1">{m.name}</div>
                  <div className="text-[#52525B] mb-2">{m.region}</div>
                  <div className="flex justify-between border-t border-[#E5E5E5] pt-2 mt-1">
                    <span className="text-[#52525B]">Befolkning</span>
                    <span className="font-semibold">{new Intl.NumberFormat("sv-SE").format(m.population)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#52525B]">Bostadstransaktioner / år</span>
                    <span className="font-semibold">~{new Intl.NumberFormat("sv-SE").format(m.transactions)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#52525B]">Konkurrenter</span>
                    <span className="font-semibold">{m.competitor_count}</span>
                  </div>
                  <div className="mt-2 pt-2 border-t border-[#E5E5E5]">
                    {covered ? (
                      <span className="text-[#16A34A] font-display font-bold text-xs uppercase tracking-wider">
                        ● Skandia finns
                      </span>
                    ) : (
                      <span className="text-[#CBA135] font-display font-bold text-xs uppercase tracking-wider">
                        ○ White spot
                      </span>
                    )}
                  </div>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>
    </div>
  );
}
```


## Frontend — Pages

### `frontend/src/pages/Brokers.jsx`

```jsx
import { useEffect, useState } from "react";
import { MagnifyingGlass, DownloadSimple, Phone, EnvelopeSimple, ArrowSquareOut } from "@phosphor-icons/react";
import { api, downloadCsv, formatNumber } from "../lib/api";
import { Input } from "../components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

export default function Brokers() {
  const [items, setItems] = useState([]);
  const [q, setQ] = useState("");

  const load = async () => {
    const res = await api.get("/brokers", { params: { q, limit: 500 } });
    setItems(res.data.items || []);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [q]);

  return (
    <div data-testid="brokers-page" className="flex flex-col gap-6">
      <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <div className="overline">Människor</div>
          <h1 className="font-display font-extrabold tracking-tighter text-4xl mt-1">
            Mäklarregister
          </h1>
          <p className="text-[#52525B] text-sm mt-2 font-body">
            Visar {formatNumber(items.length)} mäklare.
          </p>
        </div>
        <div className="flex gap-2">
          <div className="relative">
            <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A1A1AA]" />
            <Input
              data-testid="brokers-search"
              placeholder="Sök namn, ort, kontor…"
              className="input-base pl-8 w-72"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <button
            data-testid="export-brokers-csv"
            onClick={() => downloadCsv("/export/brokers.csv", "skandia-maklare.csv")}
            className="btn-secondary inline-flex items-center gap-1.5"
          >
            <DownloadSimple size={14} /> CSV
          </button>
        </div>
      </header>

      <div className="card-surface overflow-hidden">
        <Table data-testid="brokers-table">
          <TableHeader>
            <TableRow className="bg-[#FAFAFA]">
              <TableHead className="overline">Mäklare</TableHead>
              <TableHead className="overline">Roll</TableHead>
              <TableHead className="overline">Kontor</TableHead>
              <TableHead className="overline">Aktiva objekt</TableHead>
              <TableHead className="overline">YTD sålda</TableHead>
              <TableHead className="overline">Kontakt</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((b) => (
              <TableRow key={b.id} className="row-hover">
                <TableCell className="py-3">
                  <div className="flex items-center gap-3">
                    <img
                      src={b.avatar_url}
                      alt=""
                      className="w-9 h-9 rounded-full object-cover border border-[#E5E5E5]"
                      onError={(e) => { e.target.style.display = "none"; }}
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <div className="font-display font-bold text-[13px] text-[#0A0A0A]">{b.name}</div>
                        {b.profile_url && (
                          <a
                            href={b.profile_url}
                            target="_blank"
                            rel="noreferrer"
                            title="Öppna profil på skandiamaklarna.se"
                            data-testid={`broker-link-${b.id}`}
                            className="text-[#A1A1AA] hover:text-[#CBA135] transition-colors"
                          >
                            <ArrowSquareOut size={12} weight="bold" />
                          </a>
                        )}
                      </div>
                      <div className="text-[11px] text-[#A1A1AA] font-body">{b.email}</div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-[13px] font-body text-[#52525B]">{b.title}</TableCell>
                <TableCell>
                  <div className="text-[13px] font-body text-[#0A0A0A]">{b.office_name}</div>
                  <div className="text-[11px] text-[#A1A1AA] font-body">{b.city}</div>
                </TableCell>
                <TableCell className="font-display font-bold text-[13px] tabular-nums">{b.active_listings}</TableCell>
                <TableCell className="font-display font-bold text-[13px] tabular-nums text-[#CBA135]">{b.ytd_sales}</TableCell>
                <TableCell>
                  <div className="flex gap-3 text-[12px] font-body text-[#52525B]">
                    <a href={`tel:${b.phone}`} className="inline-flex items-center gap-1 hover:text-[#CBA135]">
                      <Phone size={11} /> {b.phone}
                    </a>
                    <a href={`mailto:${b.email}`} className="inline-flex items-center gap-1 hover:text-[#CBA135]">
                      <EnvelopeSimple size={11} />
                    </a>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!items.length && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-[#A1A1AA] text-sm py-12">
                  Inga mäklare matchar.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
```


### `frontend/src/pages/Dashboard.jsx`

```jsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  ArrowsClockwise,
  Buildings,
  UsersThree,
  Briefcase,
  Target,
  Compass,
  Clock,
  XCircle,
  Lightning,
  Warning,
  CheckCircle,
} from "@phosphor-icons/react";
import { api, formatNumber, PIPELINE_STATUSES, STATUS_TONE, daysSince } from "../lib/api";
import KpiCard from "../components/KpiCard";
import ActivityFeed from "../components/ActivityFeed";

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [insights, setInsights] = useState(null);
  const [officeGoals, setOfficeGoals] = useState(null);

  const load = async () => {
    const [k, i, og] = await Promise.all([
      api.get("/dashboard/kpis"),
      api.get("/dashboard/insights"),
      api.get("/dashboard/office-recruitment"),
    ]);
    setData(k.data);
    setInsights(i.data);
    setOfficeGoals(og.data);
  };

  useEffect(() => {
    load();
  }, []);

  if (!data) {
    return <div className="text-sm text-[#52525B]" data-testid="dashboard-loading">Laddar dashboard…</div>;
  }

  const pipelineEntries = PIPELINE_STATUSES.map((s) => [s, data.pipeline[s] || 0]);
  const totalInPipeline = pipelineEntries.reduce((sum, [, c]) => sum + c, 0);

  return (
    <div data-testid="dashboard-page" className="flex flex-col gap-8">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <div className="overline">Översikt</div>
          <h1 className="font-display font-extrabold tracking-tighter text-[#0A0A0A] text-4xl sm:text-5xl mt-1">
            God morgon, Delfi.
          </h1>
          <p className="text-[#52525B] text-sm md:text-base font-body mt-2 max-w-xl">
            Hela rikstäckningen av Skandiamäklarna och din värvnings-pipeline på en sida.
            Senast uppdaterad {new Date(data.as_of).toLocaleString("sv-SE")}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            data-testid="header-refresh-btn"
            onClick={load}
            className="btn-ghost inline-flex items-center gap-1.5"
          >
            <ArrowsClockwise size={14} /> Uppdatera
          </button>
          <Link
            to="/scrape"
            data-testid="header-scrape-link"
            className="btn-primary inline-flex items-center gap-1.5"
          >
            <Compass size={14} weight="duotone" />
            Scraping
          </Link>
        </div>
      </header>

      {/* KPI row */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          testId="kpi-offices"
          label="Kontor i kedjan"
          value={data.offices}
          sub={`${data.regions_covered} regioner med närvaro`}
        />
        <KpiCard
          testId="kpi-pipeline"
          label="Värvningsprospekt"
          value={data.prospects_total}
          sub={`${totalInPipeline} aktiva i pipeline`}
          accent
        />
        <KpiCard
          testId="kpi-pipeline-value"
          label="Pipeline-värde (SEK)"
          value={
            data.pipeline_value
              ? new Intl.NumberFormat("sv-SE", {
                  notation: "compact",
                  maximumFractionDigits: 1,
                }).format(data.pipeline_value)
              : "0"
          }
          sub="Förv. intäkt år 1 + signing bonus"
        />
        <KpiCard
          testId="kpi-stale"
          label={`Fastnat (>${data.stale_days || 14} dgr)`}
          value={data.stale_count || 0}
          sub={
            (data.stale_count || 0) > 0
              ? "Kräver uppföljning"
              : "Allt rör sig framåt"
          }
        />
      </section>

      {/* Pipeline mini + goals */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="card-surface p-6 lg:col-span-2 fade-up delay-1">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="overline">Pipeline</div>
              <h2 className="font-display font-extrabold tracking-tight text-xl mt-1">
                Värvningstratt
              </h2>
            </div>
            <Link
              to="/pipeline"
              data-testid="open-pipeline-link"
              className="btn-ghost inline-flex items-center gap-1 text-xs"
            >
              Öppna kanban <ArrowUpRight size={12} />
            </Link>
          </div>
          <div className="flex flex-col gap-3">
            {pipelineEntries.map(([status, count]) => {
              const tone = STATUS_TONE[status];
              const max = Math.max(...pipelineEntries.map(([, c]) => c), 1);
              const pct = (count / max) * 100;
              return (
                <div
                  key={status}
                  data-testid={`pipeline-row-${status}`}
                  className="flex items-center gap-3"
                >
                  <div className="w-28 text-[12px] font-display font-semibold text-[#0A0A0A]">
                    {status}
                  </div>
                  <div className="flex-1 h-2 bg-[#F4F4F5] rounded-full overflow-hidden">
                    <div
                      className="h-full"
                      style={{ width: `${pct}%`, background: tone.dot }}
                    />
                  </div>
                  <div className="w-8 text-right font-display font-bold tabular-nums text-sm">
                    {count}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card-surface p-6 fade-up delay-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="overline">Mål Q1–Q4 2026</div>
              <h2 className="font-display font-extrabold tracking-tight text-xl mt-1 flex items-center gap-2">
                <Target size={18} color="#CBA135" weight="duotone" /> Status
              </h2>
            </div>
          </div>
          <div className="flex flex-col gap-4">
            {data.goals?.map((g) => {
              const pct = Math.min(100, Math.round((g.current / Math.max(g.target, 1)) * 100));
              return (
                <div key={g.id} data-testid={`goal-${g.id}`}>
                  <div className="flex justify-between items-baseline">
                    <div className="font-display font-bold text-[13px] text-[#0A0A0A]">{g.title}</div>
                    <div className="text-[11px] font-display font-semibold text-[#52525B] tabular-nums">
                      {g.current}/{g.target}
                    </div>
                  </div>
                  <div className="mt-1.5 h-1.5 bg-[#F4F4F5] rounded-full overflow-hidden">
                    <div
                      className="h-full"
                      style={{ width: `${pct}%`, background: "#CBA135" }}
                    />
                  </div>
                  <div className="text-[11px] text-[#A1A1AA] mt-1 font-body">
                    Deadline {g.deadline || "—"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Activity + Quick nav */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="card-surface p-6 lg:col-span-2 fade-up delay-3">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="overline">Aktivitet</div>
              <h2 className="font-display font-extrabold tracking-tight text-xl mt-1">
                Senaste händelser
              </h2>
            </div>
          </div>
          <ActivityFeed items={data.activity} />
        </div>

        <div className="flex flex-col gap-4 fade-up delay-4">
          <Link
            to="/map"
            data-testid="quick-link-map"
            className="card-surface p-5 hover:-translate-y-1 transition-transform group"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="overline">Geografisk täckning</div>
                <div className="font-display font-extrabold text-xl mt-1">
                  Karta & White Spots
                </div>
                <div className="text-xs text-[#52525B] mt-2 font-body">
                  Se kommuner utan Skandia-kontor.
                </div>
              </div>
              <ArrowUpRight size={20} className="text-[#A1A1AA] group-hover:text-[#CBA135]" />
            </div>
          </Link>
          <Link
            to="/brokers"
            data-testid="quick-link-brokers"
            className="card-surface p-5 hover:-translate-y-1 transition-transform group"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="overline">Människor</div>
                <div className="font-display font-extrabold text-xl mt-1">
                  Mäklarregister
                </div>
                <div className="text-xs text-[#52525B] mt-2 font-body">
                  Sök bland alla {formatNumber(data.brokers)} mäklare.
                </div>
              </div>
              <UsersThree size={20} weight="duotone" className="text-[#A1A1AA] group-hover:text-[#CBA135]" />
            </div>
          </Link>
          <Link
            to="/offices"
            data-testid="quick-link-offices"
            className="card-surface p-5 hover:-translate-y-1 transition-transform group"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="overline">Närvaro</div>
                <div className="font-display font-extrabold text-xl mt-1">
                  Kontor
                </div>
                <div className="text-xs text-[#52525B] mt-2 font-body">
                  Alla {formatNumber(data.offices)} kontor i kedjan.
                </div>
              </div>
              <Buildings size={20} weight="duotone" className="text-[#A1A1AA] group-hover:text-[#CBA135]" />
            </div>
          </Link>
        </div>
      </section>

      {/* Insights — sources + lost-to + stale */}
      {insights && (
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="card-surface p-6 fade-up" data-testid="insights-sources">
            <div className="overline mb-1">Källfördelning</div>
            <h2 className="font-display font-extrabold tracking-tight text-xl mb-4 flex items-center gap-2">
              <Lightning size={18} color="#CBA135" weight="duotone" /> Varifrån kommer leadsen?
            </h2>
            {insights.sources?.length ? (
              <div className="flex flex-col gap-2.5">
                {insights.sources.map((s) => {
                  const max = Math.max(...insights.sources.map((x) => x.count), 1);
                  const pct = (s.count / max) * 100;
                  return (
                    <div key={s.source} className="flex items-center gap-3">
                      <div className="w-32 text-[12px] font-display font-semibold text-[#0A0A0A] truncate">
                        {s.source}
                      </div>
                      <div className="flex-1 h-1.5 bg-[#F4F4F5] rounded-full overflow-hidden">
                        <div className="h-full bg-[#CBA135]" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="w-8 text-right font-display font-bold tabular-nums text-sm">
                        {s.count}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-sm text-[#A1A1AA] py-4 font-body">
                Lägg till källa när du skapar prospekt så syns fördelningen här.
              </div>
            )}
          </div>

          <div className="card-surface p-6 fade-up delay-1" data-testid="insights-lost">
            <div className="flex items-center justify-between mb-1">
              <div className="overline">Konkurrentintelligens</div>
              <Link to="/lost" className="text-[11px] font-display font-bold text-[#52525B] hover:text-[#CBA135] inline-flex items-center gap-0.5">
                Visa alla <ArrowUpRight size={11} />
              </Link>
            </div>
            <h2 className="font-display font-extrabold tracking-tight text-xl mb-4 flex items-center gap-2">
              <XCircle size={18} color="#DC2626" weight="duotone" /> Förlorade till
            </h2>
            {insights.lost_breakdown?.length ? (
              <div className="flex flex-col gap-2.5">
                {insights.lost_breakdown.slice(0, 6).map((l) => {
                  const max = Math.max(...insights.lost_breakdown.map((x) => x.count), 1);
                  const pct = (l.count / max) * 100;
                  return (
                    <div key={l.agency} className="flex items-center gap-3">
                      <div className="w-32 text-[12px] font-display font-semibold text-[#0A0A0A] truncate">
                        {l.agency}
                      </div>
                      <div className="flex-1 h-1.5 bg-[#F4F4F5] rounded-full overflow-hidden">
                        <div className="h-full bg-[#DC2626]" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="w-8 text-right font-display font-bold tabular-nums text-sm">
                        {l.count}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-sm text-[#A1A1AA] py-4 font-body">
                Inga förlorade prospekt än. Bra jobbat.
              </div>
            )}
          </div>

          <div className="card-surface p-6 fade-up delay-2" data-testid="insights-stale">
            <div className="overline mb-1">Stale-alerts</div>
            <h2 className="font-display font-extrabold tracking-tight text-xl mb-4 flex items-center gap-2">
              <Clock size={18} color="#F59E0B" weight="duotone" />
              Fastnat &gt;{insights.stale_days} dgr
            </h2>
            {insights.top_stale?.length ? (
              <ul className="flex flex-col divide-y divide-[#E5E5E5]">
                {insights.top_stale.map((p) => {
                  const d = daysSince(p.updated_at);
                  return (
                    <li key={p.id} className="py-2.5 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-display font-bold text-[13px] text-[#0A0A0A] truncate">{p.name}</div>
                        <div className="text-[11px] text-[#52525B] font-body truncate">
                          {p.status} · {p.owner_name || "Otilldelad"}
                        </div>
                      </div>
                      <span
                        className="text-[11px] font-display font-bold uppercase tracking-wider px-1.5 py-0.5 rounded whitespace-nowrap"
                        style={{
                          background: d >= 30 ? "#FEF2F2" : "#FEF3C7",
                          color: d >= 30 ? "#7F1D1D" : "#7C2D12",
                        }}
                      >
                        {d}d
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="text-sm text-[#A1A1AA] py-4 font-body">
                Inga fastnat just nu. Skickligt jobbat.
              </div>
            )}
            <Link
              to="/pipeline"
              className="mt-4 inline-flex items-center gap-1 text-[12px] font-display font-bold text-[#CBA135]"
            >
              Öppna pipeline <ArrowUpRight size={11} />
            </Link>
          </div>
        </section>
      )}

      {/* Office recruitment rollup */}
      {officeGoals && officeGoals.totals.with_goal > 0 && (
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6" data-testid="office-recruitment-rollup">
          <div className="card-surface p-6 fade-up lg:col-span-2">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="overline">Rekrytering per kontor</div>
                <h2 className="font-display font-extrabold tracking-tight text-xl mt-1 flex items-center gap-2">
                  <Buildings size={18} color="#CBA135" weight="duotone" />
                  Mål vs utfall · {officeGoals.totals.with_goal} kontor med mål
                </h2>
              </div>
              <Link to="/offices" className="btn-ghost inline-flex items-center gap-1 text-xs">
                Alla kontor <ArrowUpRight size={11} />
              </Link>
            </div>

            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="text-center p-3 rounded-md bg-[#DCFCE7]">
                <div className="text-[10px] uppercase tracking-wider font-display font-bold text-[#14532D]">I fas</div>
                <div className="font-display font-extrabold text-2xl tabular-nums text-[#16A34A] mt-1">{officeGoals.totals.on_track}</div>
              </div>
              <div className="text-center p-3 rounded-md bg-[#FEF2F2]">
                <div className="text-[10px] uppercase tracking-wider font-display font-bold text-[#7F1D1D]">Efter mål</div>
                <div className="font-display font-extrabold text-2xl tabular-nums text-[#DC2626] mt-1">{officeGoals.totals.behind}</div>
              </div>
              <div className="text-center p-3 rounded-md bg-[#FAF3E1]">
                <div className="text-[10px] uppercase tracking-wider font-display font-bold text-[#7C5A0F]">Totalt mål</div>
                <div className="font-display font-extrabold text-2xl tabular-nums text-[#CBA135] mt-1">{officeGoals.totals.total_signed}/{officeGoals.totals.total_target}</div>
              </div>
            </div>

            <ul className="flex flex-col divide-y divide-[#E5E5E5]">
              {officeGoals.rows.filter((r) => r.target_hires > 0).slice(0, 6).map((r) => {
                const pct = r.target_hires > 0 ? Math.min(100, Math.round((r.current_hires / r.target_hires) * 100)) : 0;
                const color = r.status === "behind" ? "#DC2626" : "#22C55E";
                return (
                  <li
                    key={r.office_id}
                    data-testid={`rollup-row-${r.office_id}`}
                    className="py-2.5"
                  >
                    <Link to={`/offices/${r.office_id}`} className="flex items-center gap-3 group">
                      {r.status === "behind" ? (
                        <Warning size={14} color="#DC2626" weight="duotone" />
                      ) : (
                        <CheckCircle size={14} color="#22C55E" weight="duotone" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-display font-bold text-[13px] truncate group-hover:text-[#CBA135]">{r.office_name}</div>
                        <div className="text-[11px] text-[#52525B] font-body">
                          {r.city}{r.deadline ? ` · deadline ${r.deadline.slice(0, 10)}` : ""}
                        </div>
                      </div>
                      <div className="flex-1 max-w-[160px] hidden sm:block">
                        <div className="h-1.5 bg-[#F4F4F5] rounded-full overflow-hidden">
                          <div className="h-full" style={{ width: `${pct}%`, background: color }} />
                        </div>
                      </div>
                      <div className="text-right font-display font-extrabold tabular-nums text-sm w-12">
                        {r.current_hires}/{r.target_hires}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="card-surface p-6 fade-up delay-1">
            <div className="overline mb-1">Öppna behov</div>
            <h2 className="font-display font-extrabold tracking-tight text-xl mb-4 flex items-center gap-2">
              <Target size={18} color="#CBA135" weight="duotone" />
              {officeGoals.totals.open_needs} behov flaggade
            </h2>
            {officeGoals.open_needs.length === 0 ? (
              <p className="text-sm text-[#A1A1AA] font-body">
                Inga specifika behov flaggade från kontorscheferna.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {officeGoals.open_needs.slice(0, 8).map((n, i) => (
                  <li key={i} className="text-[13px] font-body">
                    <span className="font-display font-bold text-[#0A0A0A]">{n.office_name}:</span>{" "}
                    <span className="text-[#52525B]">{n.need}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
```


### `frontend/src/pages/Login.jsx`

```jsx
import { useState } from "react";
import { useNavigate, Navigate } from "react-router-dom";
import { Compass, SignIn } from "@phosphor-icons/react";
import { useAuth, formatApiError } from "../lib/auth";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

export default function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (user && user !== false) return <Navigate to="/" replace />;

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email.trim(), password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(formatApiError(err.response?.data?.detail) || err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      data-testid="login-page"
      className="min-h-screen flex items-center justify-center bg-[#FAFAFA] px-4"
    >
      <div className="w-full max-w-[400px]">
        <div className="flex items-center gap-2.5 mb-10">
          <div className="w-9 h-9 rounded-md bg-[#0A0A0A] flex items-center justify-center">
            <Compass size={18} weight="duotone" color="#CBA135" />
          </div>
          <div className="leading-tight">
            <div className="font-display font-extrabold tracking-tight text-[#0A0A0A] text-base">
              Etablering
            </div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-[#A1A1AA] font-display font-semibold">
              Skandiamäklarna
            </div>
          </div>
        </div>

        <div className="overline">Logga in</div>
        <h1 className="font-display font-extrabold tracking-tighter text-[#0A0A0A] text-4xl mt-1">
          Välkommen tillbaka.
        </h1>
        <p className="text-[#52525B] text-sm mt-2 font-body">
          Logga in med din arbetsmejl för att fortsätta.
        </p>

        <form onSubmit={submit} className="mt-8 flex flex-col gap-4">
          <div>
            <Label className="overline">E-post</Label>
            <Input
              data-testid="login-email"
              type="email"
              autoComplete="email"
              className="input-base mt-1.5"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <Label className="overline">Lösenord</Label>
            <Input
              data-testid="login-password"
              type="password"
              autoComplete="current-password"
              className="input-base mt-1.5"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && (
            <div
              data-testid="login-error"
              className="text-[13px] text-[#7F1D1D] bg-[#FEF2F2] border border-[#FECACA] px-3 py-2 rounded font-body"
            >
              {error}
            </div>
          )}

          <button
            data-testid="login-submit"
            type="submit"
            disabled={loading}
            className="btn-primary mt-2 inline-flex items-center justify-center gap-2"
          >
            <SignIn size={14} weight="bold" />
            {loading ? "Loggar in…" : "Logga in"}
          </button>
        </form>

        <p className="mt-8 text-[12px] text-[#A1A1AA] font-body">
          Glömt lösenord? Kontakta din admin för återställning.
        </p>
      </div>
    </div>
  );
}
```


### `frontend/src/pages/Lost.jsx`

```jsx
import { useEffect, useState } from "react";
import { ArrowCounterClockwise, MagnifyingGlass, DownloadSimple, Warning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, downloadCsv, formatDate } from "../lib/api";
import { Input } from "../components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

export default function Lost() {
  const [items, setItems] = useState([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(null);

  const load = async () => {
    // include_lost=true & status=any
    const res = await api.get("/prospects", { params: { q, include_lost: true } });
    const lost = (res.data.items || []).filter((p) => p.is_lost);
    setItems(lost);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const restore = async (p) => {
    if (!confirm(`Återställ ${p.name} till pipeline?`)) return;
    setBusy(p.id);
    try {
      await api.post(`/prospects/${p.id}/restore`);
      toast.success(`${p.name} återställd`);
      load();
    } catch (e) {
      toast.error("Kunde inte återställa: " + e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="lost-page" className="flex flex-col gap-6">
      <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <div className="overline">Förlorade prospekt</div>
          <h1 className="font-display font-extrabold tracking-tighter text-4xl mt-1">
            Förlorade till konkurrenter
          </h1>
          <p className="text-[#52525B] text-sm mt-2 font-body max-w-2xl">
            {items.length} prospekt som tackat nej eller gått till annan kedja.
            Återställ för att flytta tillbaka till aktiva pipelinen.
          </p>
        </div>
        <div className="flex gap-2">
          <div className="relative">
            <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A1A1AA]" />
            <Input
              data-testid="lost-search"
              placeholder="Sök namn, ort, kedja…"
              className="input-base pl-8 w-72"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <button
            data-testid="export-lost-csv"
            onClick={() => downloadCsv("/export/prospects.csv", "skandia-prospekt-alla.csv")}
            className="btn-secondary inline-flex items-center gap-1.5"
          >
            <DownloadSimple size={14} /> CSV
          </button>
        </div>
      </header>

      <div className="card-surface overflow-hidden">
        <Table data-testid="lost-table">
          <TableHeader>
            <TableRow className="bg-[#FAFAFA]">
              <TableHead className="overline">Prospekt</TableHead>
              <TableHead className="overline">Förlorad till</TableHead>
              <TableHead className="overline">Anledning</TableHead>
              <TableHead className="overline">Förlorad</TableHead>
              <TableHead className="overline w-28"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((p) => (
              <TableRow key={p.id} className="row-hover" data-testid={`lost-row-${p.id}`}>
                <TableCell>
                  <div className="font-display font-bold text-[14px] text-[#0A0A0A]">{p.name}</div>
                  <div className="text-[12px] text-[#52525B] font-body">
                    {p.city || "—"}{p.current_agency ? ` · från ${p.current_agency}` : ""}
                  </div>
                </TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded font-display font-bold text-[12px] bg-[#FEF2F2] text-[#7F1D1D]">
                    <Warning size={11} weight="duotone" /> {p.lost_to_agency || "—"}
                  </span>
                </TableCell>
                <TableCell className="text-sm text-[#52525B] font-body max-w-md">
                  {p.lost_reason || <span className="text-[#A1A1AA]">—</span>}
                </TableCell>
                <TableCell className="text-sm font-body text-[#52525B]">
                  {formatDate(p.lost_at)}
                </TableCell>
                <TableCell>
                  <button
                    onClick={() => restore(p)}
                    disabled={busy === p.id}
                    className="btn-secondary inline-flex items-center gap-1 text-xs"
                    data-testid={`restore-${p.id}`}
                  >
                    <ArrowCounterClockwise size={12} /> Återställ
                  </button>
                </TableCell>
              </TableRow>
            ))}
            {!items.length && (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-12 text-[#A1A1AA] text-sm">
                  Inga förlorade prospekt än. Bra jobbat.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
```


### `frontend/src/pages/MapView.jsx`

```jsx
import { useEffect, useState } from "react";
import { api, formatNumber } from "../lib/api";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";
import SwedenMap from "../components/SwedenMap";
import DiscoverySheet from "../components/DiscoverySheet";
import { Sparkle } from "@phosphor-icons/react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

export default function MapView() {
  const [whitespots, setWhitespots] = useState([]);
  const [mode, setMode] = useState("all");
  const [openCity, setOpenCity] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    api.get("/geo/whitespots", { params: { min_population: 25000, limit: 30 } })
      .then((r) => setWhitespots(r.data.items));
  }, []);

  const openDiscovery = (city) => {
    setOpenCity(city);
    setSheetOpen(true);
  };

  return (
    <div data-testid="map-page" className="flex flex-col gap-6">
      <header>
        <div className="overline">Geografisk översikt</div>
        <h1 className="font-display font-extrabold tracking-tighter text-4xl mt-1">
          Karta & White Spots
        </h1>
        <p className="text-[#52525B] text-sm mt-2 font-body max-w-2xl">
          Svarta cirklar = Skandiamäklarna har närvaro. Champagne-cirklar = white spots.
          Sortera tabellen efter opportunity score för att hitta högst potential.
        </p>
      </header>

      <Tabs defaultValue="all" onValueChange={setMode}>
        <TabsList data-testid="map-tabs" className="bg-[#F4F4F5]">
          <TabsTrigger value="all" data-testid="map-tab-all">Alla</TabsTrigger>
          <TabsTrigger value="covered" data-testid="map-tab-covered">Skandia-närvaro</TabsTrigger>
          <TabsTrigger value="whitespots" data-testid="map-tab-whitespots">White Spots</TabsTrigger>
        </TabsList>
        <TabsContent value="all" className="mt-4"><SwedenMap mode="all" height={520} /></TabsContent>
        <TabsContent value="covered" className="mt-4"><SwedenMap mode="covered" height={520} /></TabsContent>
        <TabsContent value="whitespots" className="mt-4"><SwedenMap mode="whitespots" height={520} /></TabsContent>
      </Tabs>

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <div className="overline">Topp 30</div>
            <h2 className="font-display font-extrabold tracking-tight text-2xl mt-1">
              Prioriterade white spots
            </h2>
          </div>
          <div className="text-xs text-[#52525B] font-body">
            Klicka på rad → öppna lead discovery
          </div>
        </div>
        <div className="card-surface overflow-hidden">
          <Table data-testid="whitespots-table">
            <TableHeader>
              <TableRow className="bg-[#FAFAFA]">
                <TableHead className="overline">Kommun</TableHead>
                <TableHead className="overline">Region</TableHead>
                <TableHead className="overline text-right">Befolkning</TableHead>
                <TableHead className="overline text-right">Transaktioner/år</TableHead>
                <TableHead className="overline">Konkurrenter</TableHead>
                <TableHead className="overline text-right">Score</TableHead>
                <TableHead className="overline w-32"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {whitespots.map((m) => (
                <TableRow
                  key={m.name}
                  className="row-hover cursor-pointer"
                  data-testid={`whitespot-${m.name}`}
                  onClick={() => openDiscovery(m.name)}
                >
                  <TableCell className="font-display font-bold text-[#0A0A0A]">{m.name}</TableCell>
                  <TableCell className="font-body text-sm text-[#52525B]">{m.region}</TableCell>
                  <TableCell className="text-right tabular-nums font-body text-sm">{formatNumber(m.population)}</TableCell>
                  <TableCell className="text-right tabular-nums font-body text-sm">~{formatNumber(m.transactions)}</TableCell>
                  <TableCell className="font-body text-[12px] text-[#52525B]">{m.competitors.join(", ")}</TableCell>
                  <TableCell className="text-right font-display font-extrabold text-[#CBA135] tabular-nums">{m.opportunity_score}</TableCell>
                  <TableCell>
                    <button
                      onClick={(e) => { e.stopPropagation(); openDiscovery(m.name); }}
                      data-testid={`discover-btn-${m.name}`}
                      className="btn-secondary inline-flex items-center gap-1 text-[12px] whitespace-nowrap"
                    >
                      <Sparkle size={12} weight="duotone" /> Discovery
                    </button>
                  </TableCell>
                </TableRow>
              ))}
              {!whitespots.length && (
                <TableRow><TableCell colSpan={7} className="text-center py-12 text-[#A1A1AA] text-sm">Laddar…</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <DiscoverySheet
        city={openCity}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      />
    </div>
  );
}
```


### `frontend/src/pages/OfficeDetail.jsx`

```jsx
import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  MapPin,
  Phone,
  EnvelopeSimple,
  ArrowSquareOut,
  ArrowLeft,
  Crown,
  Target,
  Plus,
  X,
  FloppyDisk,
  Warning,
  CheckCircle,
  Clock,
  LinkSimple,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, formatDate, formatDateTime, STATUS_TONE } from "../lib/api";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import StatusPill from "../components/StatusPill";
import ActivityFeed from "../components/ActivityFeed";

export default function OfficeDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [goalForm, setGoalForm] = useState({
    target_hires: 0,
    deadline: "",
    status_note: "",
    needs: [],
  });
  const [newNeed, setNewNeed] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const res = await api.get(`/offices/${id}`);
    setData(res.data);
    const g = res.data.goal;
    setGoalForm({
      target_hires: g?.target_hires ?? 0,
      deadline: (g?.deadline || "").slice(0, 10),
      status_note: g?.status_note ?? "",
      needs: g?.needs ?? [],
    });
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const saveGoal = async () => {
    setSaving(true);
    try {
      await api.put(`/offices/${id}/recruitment`, {
        target_hires: Number(goalForm.target_hires) || 0,
        deadline: goalForm.deadline || null,
        status_note: goalForm.status_note,
        needs: goalForm.needs,
      });
      toast.success("Rekryteringsmål sparat");
      load();
    } catch (e) {
      toast.error("Kunde inte spara: " + (e.response?.data?.detail || e.message));
    } finally {
      setSaving(false);
    }
  };

  const addNeed = () => {
    if (!newNeed.trim()) return;
    setGoalForm((f) => ({ ...f, needs: [...f.needs, newNeed.trim()] }));
    setNewNeed("");
  };

  const removeNeed = (idx) => {
    setGoalForm((f) => ({ ...f, needs: f.needs.filter((_, i) => i !== idx) }));
  };

  const linkCityProspects = async () => {
    const unlinkedCount = (data?.prospects || []).filter(
      (p) => !p.office_id
    ).length;
    if (!unlinkedCount) {
      toast.info("Inga ogkopplade prospekt att migrera");
      return;
    }
    if (
      !confirm(
        `Länka ${unlinkedCount} stadsmatchade prospekt explicit till ${data.office.name}?`
      )
    )
      return;
    try {
      const res = await api.post(`/offices/${id}/link-city-prospects`);
      toast.success(`${res.data.linked} prospekt kopplade till ${res.data.office_name}`);
      load();
    } catch (e) {
      toast.error("Fel: " + (e.response?.data?.detail || e.message));
    }
  };

  if (!data) {
    return <div className="text-sm text-[#52525B]">Laddar kontor…</div>;
  }

  const { office, brokers, prospects, kpis, timeline, goal } = data;
  const target = goal?.target_hires || 0;
  const pct = target > 0 ? Math.min(100, Math.round((kpis.signed_or_onboarded / target) * 100)) : 0;
  const status = target === 0 ? "no_goal" : (kpis.signed_or_onboarded / target >= 0.5 ? "on_track" : "behind");

  return (
    <div data-testid="office-detail-page" className="flex flex-col gap-6">
      <div>
        <Link
          to="/offices"
          data-testid="back-to-offices"
          className="btn-ghost inline-flex items-center gap-1 text-xs"
        >
          <ArrowLeft size={12} /> Alla kontor
        </Link>
      </div>

      <header className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <div>
          <div className="overline">Kontor</div>
          <h1 className="font-display font-extrabold tracking-tighter text-[#0A0A0A] text-4xl mt-1 flex items-center gap-3">
            {office.name}
            {office.website && (
              <a
                href={office.website}
                target="_blank"
                rel="noreferrer"
                data-testid="office-website-link"
                className="text-[#A1A1AA] hover:text-[#CBA135]"
              >
                <ArrowSquareOut size={20} weight="bold" />
              </a>
            )}
          </h1>
          <p className="text-[#52525B] text-sm mt-2 font-body flex items-center gap-1.5">
            <MapPin size={12} /> {office.address || office.city}
            <span className="text-[#D4D4D8]">·</span>
            <span>{office.region}</span>
          </p>
          {office.manager && (
            <p className="text-[#52525B] text-sm mt-1 font-body flex items-center gap-1.5">
              <Crown size={12} color="#CBA135" weight="duotone" />
              Kontorschef: <strong className="text-[#0A0A0A] font-display">{office.manager}</strong>
            </p>
          )}
        </div>
        <div className="flex gap-3">
          {office.phone && (
            <a href={`tel:${office.phone}`} className="btn-secondary inline-flex items-center gap-1.5 text-xs">
              <Phone size={12} /> {office.phone}
            </a>
          )}
          {office.email && (
            <a href={`mailto:${office.email}`} className="btn-secondary inline-flex items-center gap-1.5 text-xs">
              <EnvelopeSimple size={12} /> Mejla
            </a>
          )}
        </div>
      </header>

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiBlock label="Mäklare" value={kpis.broker_count} sub="Aktiva på kontoret" testId="kpi-brokers" />
        <KpiBlock label="Aktiva objekt" value={kpis.listing_count} sub={kpis.listing_count ? "I databas" : "(ej synkat)"} testId="kpi-listings" />
        <KpiBlock label="Prospekt i stan" value={kpis.active_prospects} sub={`${kpis.signed_or_onboarded} signerade/onboardade`} testId="kpi-prospects" />
        <KpiBlock
          label="Rekryteringsmål"
          value={target > 0 ? `${kpis.signed_or_onboarded}/${target}` : "Ej satt"}
          sub={target > 0 ? `${pct}% · ${status === "behind" ? "ligger efter" : status === "on_track" ? "i fas" : ""}` : "Sätt mål nedan"}
          tone={target > 0 ? status : "neutral"}
          testId="kpi-goal"
        />
      </section>

      {/* Recruitment goal editor */}
      <section className="card-surface p-6" data-testid="recruitment-section">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="overline">Steg 7 — Rekrytering</div>
            <h2 className="font-display font-extrabold tracking-tight text-xl mt-1 flex items-center gap-2">
              <Target size={18} color="#CBA135" weight="duotone" /> Mål för {office.name}
            </h2>
          </div>
          <button
            data-testid="save-goal-btn"
            onClick={saveGoal}
            disabled={saving}
            className="btn-primary inline-flex items-center gap-1.5"
          >
            <FloppyDisk size={14} /> {saving ? "Sparar…" : "Spara mål"}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <Label className="overline">Antal nya mäklare (mål)</Label>
            <Input
              type="number"
              min="0"
              data-testid="target-hires-input"
              className="input-base mt-1.5 text-2xl font-display font-bold tabular-nums"
              value={goalForm.target_hires}
              onChange={(e) => setGoalForm({ ...goalForm, target_hires: e.target.value })}
            />
            {target > 0 && (
              <div className="mt-2">
                <div className="h-2 bg-[#F4F4F5] rounded-full overflow-hidden">
                  <div
                    className="h-full"
                    style={{
                      width: `${pct}%`,
                      background: status === "behind" ? "#DC2626" : status === "on_track" ? "#22C55E" : "#CBA135",
                    }}
                  />
                </div>
                <div className="text-[11px] text-[#52525B] mt-1 font-body">
                  {kpis.signed_or_onboarded} av {target} klara ({pct}%)
                </div>
              </div>
            )}
          </div>
          <div>
            <Label className="overline">Deadline</Label>
            <Input
              type="date"
              data-testid="deadline-input"
              className="input-base mt-1.5"
              value={goalForm.deadline}
              onChange={(e) => setGoalForm({ ...goalForm, deadline: e.target.value })}
            />
            <div className="text-[11px] text-[#52525B] mt-1 font-body">
              {goalForm.deadline ? `Slut: ${formatDate(goalForm.deadline)}` : "Ingen deadline satt"}
            </div>
          </div>
          <div>
            <Label className="overline">Status-flagga</Label>
            <Textarea
              data-testid="status-note-input"
              className="input-base mt-1.5 font-body"
              rows={3}
              placeholder='t.ex. "Tappar Maria i augusti, behöver ersättare"'
              value={goalForm.status_note}
              onChange={(e) => setGoalForm({ ...goalForm, status_note: e.target.value })}
            />
          </div>
        </div>

        <div className="mt-6">
          <Label className="overline">Specifika behov / kravprofiler</Label>
          <div className="mt-2 flex gap-2">
            <Input
              data-testid="new-need-input"
              className="input-base flex-1"
              placeholder='t.ex. "BR-specialist", "Erfaren mäklare 5+ år"'
              value={newNeed}
              onChange={(e) => setNewNeed(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addNeed();
                }
              }}
            />
            <button onClick={addNeed} className="btn-secondary inline-flex items-center gap-1.5">
              <Plus size={14} /> Lägg till
            </button>
          </div>
          {goalForm.needs.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {goalForm.needs.map((n, i) => (
                <span
                  key={i}
                  data-testid={`need-tag-${i}`}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#FAF3E1] text-[#7C5A0F] text-[12px] font-display font-semibold"
                >
                  {n}
                  <button onClick={() => removeNeed(i)} className="hover:text-[#DC2626]">
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {goal?.updated_by_name && (
          <p className="text-[11px] text-[#A1A1AA] mt-4 font-display font-semibold uppercase tracking-wider">
            Senast uppdaterat {formatDateTime(goal.updated_at)} av {goal.updated_by_name}
          </p>
        )}
      </section>

      {/* Prospects in city */}
      <section>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div>
            <div className="overline">Värvning</div>
            <h2 className="font-display font-extrabold tracking-tight text-2xl mt-1">
              Prospekt i {office.city}
            </h2>
          </div>
          <div className="flex gap-2 items-center">
            {(() => {
              const unlinked = prospects.filter((p) => !p.office_id).length;
              if (unlinked === 0) return null;
              return (
                <button
                  data-testid="link-city-prospects-btn"
                  onClick={linkCityProspects}
                  className="btn-secondary inline-flex items-center gap-1.5 text-xs"
                  title="Sätt office_id explicit på alla stadsmatchade prospekt"
                >
                  <LinkSimple size={12} weight="bold" /> Länka {unlinked} stadsmatchade
                </button>
              );
            })()}
            <Link to="/pipeline" className="btn-ghost inline-flex items-center gap-1 text-xs">
              Öppna pipeline →
            </Link>
          </div>
        </div>
        {prospects.length === 0 ? (
          <div className="card-surface p-8 text-center text-sm text-[#A1A1AA] font-body" data-testid="no-prospects">
            Inga prospekt i {office.city} ännu. Lägg till på pipeline-sidan.
          </div>
        ) : (
          <div className="card-surface overflow-hidden">
            <Table data-testid="office-prospects-table">
              <TableHeader>
                <TableRow className="bg-[#FAFAFA]">
                  <TableHead className="overline">Namn</TableHead>
                  <TableHead className="overline">Status</TableHead>
                  <TableHead className="overline">Koppling</TableHead>
                  <TableHead className="overline">Nuvarande kedja</TableHead>
                  <TableHead className="overline">Ansvarig</TableHead>
                  <TableHead className="overline">Nästa steg</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {prospects.map((p) => (
                  <TableRow key={p.id} className="row-hover">
                    <TableCell className="font-display font-bold text-[14px]">{p.name}</TableCell>
                    <TableCell><StatusPill status={p.status} /></TableCell>
                    <TableCell>
                      {p.office_id ? (
                        <span className="text-[11px] uppercase tracking-wider font-display font-bold text-[#16A34A] bg-[#DCFCE7] px-1.5 py-0.5 rounded">
                          ● Explicit
                        </span>
                      ) : (
                        <span className="text-[11px] uppercase tracking-wider font-display font-bold text-[#52525B] bg-[#F4F4F5] px-1.5 py-0.5 rounded">
                          Stadsmatch
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="font-body text-sm text-[#52525B]">{p.current_agency || "—"}</TableCell>
                    <TableCell className="font-body text-sm">{p.owner_name || <span className="text-[#A1A1AA]">Otilldelad</span>}</TableCell>
                    <TableCell className="font-body text-sm text-[#52525B]">
                      {p.next_step ? `${p.next_step} · ${formatDate(p.next_step_date)}` : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {/* Brokers */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <div className="overline">Människor</div>
            <h2 className="font-display font-extrabold tracking-tight text-2xl mt-1">
              Aktiva mäklare ({brokers.length})
            </h2>
          </div>
        </div>
        <div className="card-surface overflow-hidden">
          <Table data-testid="office-brokers-table">
            <TableHeader>
              <TableRow className="bg-[#FAFAFA]">
                <TableHead className="overline">Mäklare</TableHead>
                <TableHead className="overline">Roll</TableHead>
                <TableHead className="overline">Kontakt</TableHead>
                <TableHead className="overline w-20"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {brokers.map((b) => (
                <TableRow key={b.id} className="row-hover">
                  <TableCell className="py-3">
                    <div className="flex items-center gap-3">
                      <img src={b.avatar_url} alt="" className="w-9 h-9 rounded-full object-cover border border-[#E5E5E5]" onError={(e) => { e.target.style.display = "none"; }} />
                      <div>
                        <div className="font-display font-bold text-[13px]">{b.name}</div>
                        <div className="text-[11px] text-[#A1A1AA] font-body">{b.email}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-[13px] text-[#52525B] font-body">{b.title}</TableCell>
                  <TableCell className="text-[12px] text-[#52525B] font-body">{b.phone}</TableCell>
                  <TableCell>
                    {b.profile_url && (
                      <a href={b.profile_url} target="_blank" rel="noreferrer" className="btn-ghost p-1.5 inline-block">
                        <ArrowSquareOut size={12} />
                      </a>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {brokers.length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-center py-8 text-[#A1A1AA] text-sm">Inga mäklare hittade.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      {/* Timeline */}
      <section>
        <div className="overline">Tidslinje</div>
        <h2 className="font-display font-extrabold tracking-tight text-2xl mt-1 mb-3">
          Aktivitet kopplad till kontoret
        </h2>
        <div className="card-surface p-6">
          <ActivityFeed items={timeline} />
        </div>
      </section>
    </div>
  );
}

function KpiBlock({ label, value, sub, tone = "neutral", testId }) {
  const tones = {
    neutral: { border: "#E5E5E5", accent: "#0A0A0A" },
    on_track: { border: "#22C55E", accent: "#16A34A" },
    behind: { border: "#DC2626", accent: "#DC2626" },
    no_goal: { border: "#E5E5E5", accent: "#A1A1AA" },
  };
  const t = tones[tone] || tones.neutral;
  return (
    <div className="card-surface p-5 fade-up" style={{ borderColor: t.border }} data-testid={testId}>
      <div className="overline">{label}</div>
      <div className="mt-2 font-display font-extrabold tracking-tighter text-3xl" style={{ color: t.accent }}>
        {value}
      </div>
      {sub && <div className="text-[12px] text-[#52525B] font-body mt-1">{sub}</div>}
    </div>
  );
}
```


### `frontend/src/pages/Offices.jsx`

```jsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { MagnifyingGlass, DownloadSimple, MapPin, Phone, EnvelopeSimple, ArrowSquareOut, CaretRight } from "@phosphor-icons/react";
import { api, downloadCsv } from "../lib/api";
import { Input } from "../components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

export default function Offices() {
  const [items, setItems] = useState([]);
  const [q, setQ] = useState("");

  const load = async () => {
    const res = await api.get("/offices", { params: { q } });
    setItems(res.data.items || []);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [q]);

  return (
    <div data-testid="offices-page" className="flex flex-col gap-6">
      <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <div className="overline">Närvaro</div>
          <h1 className="font-display font-extrabold tracking-tighter text-4xl mt-1">
            Kontor i kedjan
          </h1>
          <p className="text-[#52525B] text-sm mt-2 font-body">
            {items.length} kontor totalt. Klicka för detaljer.
          </p>
        </div>
        <div className="flex gap-2">
          <div className="relative">
            <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A1A1AA]" />
            <Input
              data-testid="offices-search"
              placeholder="Sök kontor, ort, chef…"
              className="input-base pl-8 w-72"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <button
            data-testid="export-offices-csv"
            onClick={() => downloadCsv("/export/offices.csv", "skandia-kontor.csv")}
            className="btn-secondary inline-flex items-center gap-1.5"
          >
            <DownloadSimple size={14} /> CSV
          </button>
        </div>
      </header>

      <div className="card-surface overflow-hidden">
        <Table data-testid="offices-table">
          <TableHeader>
            <TableRow className="bg-[#FAFAFA]">
              <TableHead className="overline">Kontor</TableHead>
              <TableHead className="overline">Ort / Region</TableHead>
              <TableHead className="overline">Kontorschef</TableHead>
              <TableHead className="overline">Kontakt</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((o) => (
              <TableRow key={o.id} className="row-hover">
                <TableCell className="py-4">
                  <div className="flex items-center gap-2">
                    <Link
                      to={`/offices/${o.id}`}
                      data-testid={`office-row-link-${o.id}`}
                      className="font-display font-bold text-[14px] text-[#0A0A0A] hover:text-[#CBA135] inline-flex items-center gap-1"
                    >
                      {o.name}
                      <CaretRight size={12} weight="bold" className="text-[#A1A1AA]" />
                    </Link>
                    {o.website && (
                      <a
                        href={o.website}
                        target="_blank"
                        rel="noreferrer"
                        title="Öppna på skandiamaklarna.se"
                        data-testid={`office-link-${o.id}`}
                        className="text-[#A1A1AA] hover:text-[#CBA135] transition-colors"
                      >
                        <ArrowSquareOut size={14} weight="bold" />
                      </a>
                    )}
                  </div>
                  <div className="text-[12px] text-[#52525B] font-body flex items-center gap-1 mt-0.5">
                    <MapPin size={11} /> {o.address}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="font-body text-[13px] text-[#0A0A0A]">{o.city}</div>
                  <div className="text-[12px] text-[#52525B] font-body">{o.region}</div>
                </TableCell>
                <TableCell className="font-body text-[13px] text-[#0A0A0A]">{o.manager}</TableCell>
                <TableCell>
                  <div className="flex gap-3 text-[12px] font-body text-[#52525B]">
                    <a href={`tel:${o.phone}`} className="inline-flex items-center gap-1 hover:text-[#CBA135]">
                      <Phone size={11} /> {o.phone}
                    </a>
                    <a href={`mailto:${o.email}`} className="inline-flex items-center gap-1 hover:text-[#CBA135]">
                      <EnvelopeSimple size={11} /> Mejla
                    </a>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!items.length && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-[#A1A1AA] text-sm py-12">
                  Inga kontor matchar.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
```


### `frontend/src/pages/Pipeline.jsx`

```jsx
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Plus, MagnifyingGlass, DownloadSimple, UserCircle, Clock } from "@phosphor-icons/react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { api, PIPELINE_STATUSES, STATUS_TONE, PROSPECT_SOURCES, daysSince, downloadCsv, formatDate } from "../lib/api";
import { useAuth } from "../lib/auth";
import ProspectSheet from "../components/ProspectSheet";

const empty = {
  name: "",
  type: "broker",
  current_agency: "",
  city: "",
  region: "",
  phone: "",
  email: "",
  linkedin: "",
  status: "Identifierad",
  notes: "",
  next_step: "",
  next_step_date: "",
  source: "Annat",
  referred_by: "",
  office_id: "",
};

export default function Pipeline() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [data, setData] = useState({ grouped: {}, items: [], statuses: PIPELINE_STATUSES });
  const [q, setQ] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [users, setUsers] = useState([]);
  const [offices, setOffices] = useState([]);
  const [openDialog, setOpenDialog] = useState(false);
  const [form, setForm] = useState(empty);
  const [selected, setSelected] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [dragOver, setDragOver] = useState(null);

  // Open the new-prospect dialog pre-filled if navigated with state.prefill
  useEffect(() => {
    const prefill = location.state?.prefill;
    if (prefill) {
      setForm({ ...empty, ...prefill });
      setOpenDialog(true);
      // Clear the state so we don't re-open on every render
      navigate(location.pathname, { replace: true });
    }
  }, [location.state, location.pathname, navigate]);

  const load = async () => {
    const params = { q };
    if (ownerFilter === "me") params.owner = "me";
    else if (ownerFilter === "unassigned") params.owner = "unassigned";
    else if (ownerFilter !== "all") params.owner = ownerFilter;
    const res = await api.get("/prospects", { params });
    setData(res.data);
  };

  const loadUsers = async () => {
    try {
      const res = await api.get("/users");
      setUsers(res.data.items || []);
    } catch {}
  };

  const loadOffices = async () => {
    try {
      const res = await api.get("/offices");
      setOffices(res.data.items || []);
    } catch {}
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, ownerFilter]);

  useEffect(() => { loadUsers(); loadOffices(); }, []);

  const create = async () => {
    if (!form.name.trim()) {
      toast.error("Namn krävs");
      return;
    }
    try {
      await api.post("/prospects", form);
      toast.success("Prospekt skapat");
      setForm(empty);
      setOpenDialog(false);
      load();
    } catch (e) {
      toast.error("Fel: " + (e.response?.data?.detail || e.message));
    }
  };

  const updateStatus = async (id, newStatus) => {
    try {
      await api.patch(`/prospects/${id}/status`, { status: newStatus });
      load();
    } catch (e) {
      toast.error("Kunde inte flytta: " + e.message);
    }
  };

  const onDragStart = (id) => setDragId(id);
  const onDragEnd = () => {
    setDragId(null);
    setDragOver(null);
  };
  const onDragOver = (e, status) => {
    e.preventDefault();
    setDragOver(status);
  };
  const onDrop = (status) => {
    if (dragId) updateStatus(dragId, status);
    onDragEnd();
  };

  const totalShown = useMemo(
    () => (data.items || []).length,
    [data]
  );

  return (
    <div data-testid="pipeline-page" className="flex flex-col gap-6">
      <header className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
        <div>
          <div className="overline">Värvning</div>
          <h1 className="font-display font-extrabold tracking-tighter text-[#0A0A0A] text-4xl mt-1">
            Pipeline
          </h1>
          <p className="text-[#52525B] text-sm mt-2 font-body">
            Dra prospekt mellan kolumner för att uppdatera status. {totalShown} prospekt totalt.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <Select value={ownerFilter} onValueChange={setOwnerFilter}>
            <SelectTrigger data-testid="owner-filter" className="input-base w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alla prospekt</SelectItem>
              <SelectItem value="me">Mina prospekt</SelectItem>
              <SelectItem value="unassigned">Otilldelade</SelectItem>
              {users.filter((u) => u.id !== user?.id).map((u) => (
                <SelectItem key={u.id} value={u.id}>{u.name}s prospekt</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative">
            <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A1A1AA]" />
            <Input
              data-testid="pipeline-search"
              className="input-base pl-8 w-64"
              placeholder="Sök prospekt, ort, kedja…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <button
            data-testid="export-prospects-csv"
            onClick={() => downloadCsv("/export/prospects.csv", "skandia-prospekt.csv")}
            className="btn-secondary inline-flex items-center gap-1.5"
          >
            <DownloadSimple size={14} /> CSV
          </button>
          <Dialog open={openDialog} onOpenChange={setOpenDialog}>
            <DialogTrigger asChild>
              <button data-testid="new-prospect-btn" className="btn-primary inline-flex items-center gap-1.5">
                <Plus size={14} /> Nytt prospekt
              </button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[520px] bg-white" data-testid="new-prospect-dialog">
              <DialogHeader>
                <div className="overline">Nytt prospekt</div>
                <DialogTitle className="font-display font-extrabold tracking-tight text-2xl">
                  Lägg till värvningsprospekt
                </DialogTitle>
              </DialogHeader>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                <div className="sm:col-span-2">
                  <Label className="overline">Namn *</Label>
                  <Input
                    data-testid="new-name"
                    className="input-base mt-1"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div>
                  <Label className="overline">Typ</Label>
                  <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
                    <SelectTrigger data-testid="new-type" className="input-base mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="broker">Mäklare</SelectItem>
                      <SelectItem value="office">Nytt kontor</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="overline">Status</Label>
                  <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                    <SelectTrigger data-testid="new-status" className="input-base mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PIPELINE_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="overline">Nuvarande kedja</Label>
                  <Input data-testid="new-agency" className="input-base mt-1" value={form.current_agency} onChange={(e) => setForm({ ...form, current_agency: e.target.value })} />
                </div>
                <div>
                  <Label className="overline">Ort</Label>
                  <Input data-testid="new-city" className="input-base mt-1" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
                </div>
                <div>
                  <Label className="overline">Kontor (mål)</Label>
                  <Select
                    value={form.office_id || "__none__"}
                    onValueChange={(v) => setForm({ ...form, office_id: v === "__none__" ? "" : v })}
                  >
                    <SelectTrigger data-testid="new-office" className="input-base mt-1"><SelectValue placeholder="Inget specifikt" /></SelectTrigger>
                    <SelectContent className="max-h-[300px]">
                      <SelectItem value="__none__">— Inget specifikt —</SelectItem>
                      {offices.map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          {o.name} {o.city ? `· ${o.city}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="overline">Källa</Label>
                  <Select value={form.source} onValueChange={(v) => setForm({ ...form, source: v })}>
                    <SelectTrigger data-testid="new-source" className="input-base mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PROSPECT_SOURCES.map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="overline">Referent / detalj</Label>
                  <Input
                    data-testid="new-referred-by"
                    className="input-base mt-1"
                    placeholder="t.ex. Pia Hansson"
                    value={form.referred_by}
                    onChange={(e) => setForm({ ...form, referred_by: e.target.value })}
                  />
                </div>
                <div>
                  <Label className="overline">Telefon</Label>
                  <Input className="input-base mt-1" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </div>
                <div>
                  <Label className="overline">E-post</Label>
                  <Input className="input-base mt-1" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </div>
                <div className="sm:col-span-2">
                  <Label className="overline">Anteckningar</Label>
                  <Textarea className="input-base mt-1 font-body" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-4">
                <button onClick={() => setOpenDialog(false)} className="btn-ghost">Avbryt</button>
                <button data-testid="confirm-new-prospect" onClick={create} className="btn-primary">Skapa</button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </header>

      <div className="flex gap-3 overflow-x-auto scrollbar-thin pb-3" data-testid="kanban-board">
        {PIPELINE_STATUSES.map((status) => {
          const items = data.grouped[status] || [];
          const tone = STATUS_TONE[status];
          return (
            <div
              key={status}
              data-testid={`kanban-col-${status}`}
              className={`kanban-col ${dragOver === status ? "drag-over" : ""}`}
              onDragOver={(e) => onDragOver(e, status)}
              onDragLeave={() => setDragOver(null)}
              onDrop={() => onDrop(status)}
            >
              <div className="flex items-center justify-between mb-1 px-1">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: tone.dot }} />
                  <span className="font-display font-bold text-[13px] text-[#0A0A0A]">{status}</span>
                </div>
                <span className="text-[11px] font-display font-bold text-[#52525B] tabular-nums">
                  {items.length}
                </span>
              </div>
              <div className="flex flex-col gap-2 overflow-y-auto scrollbar-thin">
                {items.map((p) => (
                  <div
                    key={p.id}
                    data-testid={`kanban-card-${p.id}`}
                    className={`kanban-card ${dragId === p.id ? "dragging" : ""}`}
                    draggable
                    onDragStart={() => onDragStart(p.id)}
                    onDragEnd={onDragEnd}
                    onClick={() => {
                      setSelected(p);
                      setSheetOpen(true);
                    }}
                  >
                    <div className="font-display font-extrabold text-[14px] text-[#0A0A0A] leading-tight">
                      {p.name}
                    </div>
                    <div className="text-[12px] text-[#52525B] mt-0.5 font-body">
                      {p.city || "—"} {p.current_agency ? ` · ${p.current_agency}` : ""}
                    </div>
                    {p.office_name && (
                      <div className="text-[11px] text-[#CBA135] font-display font-bold mt-1 truncate">
                        → {p.office_name}
                      </div>
                    )}
                    {p.next_step_date && (
                      <div className="mt-2 text-[11px] text-[#7C5A0F] bg-[#FAF3E1] inline-block px-2 py-0.5 rounded font-display font-bold">
                        {p.next_step || "Nästa steg"} · {formatDate(p.next_step_date)}
                      </div>
                    )}
                    <div className="mt-2 flex items-center justify-between gap-1">
                      <div className="flex items-center gap-1.5 text-[11px] text-[#52525B] font-body min-w-0">
                        <UserCircle size={12} weight={p.owner_id ? "fill" : "regular"}
                          color={p.owner_id ? "#CBA135" : "#A1A1AA"} />
                        <span className="truncate">{p.owner_name || "Otilldelad"}</span>
                      </div>
                      {(() => {
                        const d = daysSince(p.updated_at);
                        if (d < 14 || p.status === "Onboardad") return null;
                        const isCritical = d >= 30;
                        return (
                          <span
                            data-testid={`stale-badge-${p.id}`}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-display font-bold uppercase tracking-wider whitespace-nowrap"
                            style={{
                              background: isCritical ? "#FEF2F2" : "#FEF3C7",
                              color: isCritical ? "#7F1D1D" : "#7C2D12",
                            }}
                            title={`Inget hänt på ${d} dagar`}
                          >
                            <Clock size={9} weight="duotone" /> {d}d
                          </span>
                        );
                      })()}
                    </div>
                    {p.tags?.length > 0 && (
                      <div className="mt-2 flex gap-1 flex-wrap">
                        {p.tags.map((t) => (
                          <span key={t} className="text-[10px] uppercase tracking-wider font-display font-bold text-[#52525B] bg-[#F4F4F5] px-1.5 py-0.5 rounded">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {!items.length && (
                  <div className="text-[12px] text-[#A1A1AA] text-center py-6 border border-dashed border-[#E5E5E5] rounded-md">
                    Inget prospekt
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <ProspectSheet
        prospect={selected}
        users={users}
        offices={offices}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onUpdated={() => load()}
        onDeleted={() => load()}
      />
    </div>
  );
}
```


### `frontend/src/pages/Scrape.jsx`

```jsx
import { useEffect, useState } from "react";
import { ArrowsClockwise, WarningCircle, CheckCircle, ShieldWarning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, formatDateTime } from "../lib/api";

const STATUS_BADGE = {
  ok: { fg: "#14532D", bg: "#DCFCE7", label: "OK", Icon: CheckCircle },
  blocked: { fg: "#7C2D12", bg: "#FED7AA", label: "Blockerad", Icon: ShieldWarning },
  no_data: { fg: "#713F12", bg: "#FEF08A", label: "Ingen data", Icon: WarningCircle },
  error: { fg: "#7F1D1D", bg: "#FECACA", label: "Fel", Icon: WarningCircle },
};

export default function Scrape() {
  const [running, setRunning] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastRun, setLastRun] = useState(null);
  const [discovered, setDiscovered] = useState([]);
  const [limit, setLimit] = useState(10);

  const loadStatus = async () => {
    const [s, d] = await Promise.all([
      api.get("/scrape/status"),
      api.get("/scrape/discovered"),
    ]);
    setLastRun(s.data.last);
    setDiscovered(d.data.items || []);
  };

  useEffect(() => { loadStatus(); }, []);

  const runScrape = async () => {
    setRunning(true);
    try {
      const res = await api.post(`/scrape/run?limit=${limit}`);
      if (res.data.status === "ok") {
        toast.success(`Skrapade ${res.data.offices_parsed}/${res.data.offices_found} kontor (${res.data.brokers_parsed || 0} mäklare)`);
      } else if (res.data.status === "blocked") {
        toast.warning("Sajten svarade inte (möjlig bot-blockering).");
      } else if (res.data.status === "no_data") {
        toast.warning("Inga kontor hittades på indexsidan.");
      } else {
        toast.error(res.data.errors?.[0] || "Scrape misslyckades");
      }
      loadStatus();
    } catch (e) {
      toast.error("Fel: " + e.message);
    } finally {
      setRunning(false);
    }
  };

  const runSync = async () => {
    if (!confirm("Full sync ersätter ALLA kontor och mäklare i databasen med färsk data från skandiamaklarna.se. Befintliga prospekt/mål bevaras. Fortsätt?")) return;
    setSyncing(true);
    try {
      const res = await api.post(`/scrape/sync`, null, { timeout: 240000 });
      if (res.data.status === "ok" && res.data.replaced) {
        toast.success(`Full sync klar — ${res.data.offices_written} kontor + ${res.data.brokers_written} mäklare ersatte tidigare data`);
      } else {
        toast.error(res.data.errors?.[0] || `Sync misslyckades (${res.data.status})`);
      }
      loadStatus();
    } catch (e) {
      toast.error("Sync-fel: " + e.message);
    } finally {
      setSyncing(false);
    }
  };

  const badge = lastRun ? STATUS_BADGE[lastRun.status] || STATUS_BADGE.error : null;

  return (
    <div data-testid="scrape-page" className="flex flex-col gap-6">
      <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <div className="overline">Datakälla</div>
          <h1 className="font-display font-extrabold tracking-tighter text-4xl mt-1">
            Live-scraping
          </h1>
          <p className="text-[#52525B] text-sm mt-2 font-body max-w-2xl">
            Hämtar kontor och mäklare direkt från skandiamaklarna.se via JSON-LD.
            Använd <strong>Förhandsgranska</strong> för att testa, eller <strong>Full sync</strong>
            för att ersätta hela kontors- och mäklardatabasen med färsk data.
          </p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <select
            data-testid="scrape-limit"
            className="input-base"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          >
            <option value={3}>3 kontor</option>
            <option value={5}>5 kontor</option>
            <option value={10}>10 kontor</option>
            <option value={20}>20 kontor</option>
          </select>
          <button
            data-testid="run-scrape-btn"
            onClick={runScrape}
            disabled={running || syncing}
            className="btn-secondary inline-flex items-center gap-1.5"
          >
            <ArrowsClockwise size={14} className={running ? "animate-spin" : ""} />
            {running ? "Skrapar…" : "Förhandsgranska"}
          </button>
          <button
            data-testid="run-sync-btn"
            onClick={runSync}
            disabled={syncing || running}
            className="btn-primary inline-flex items-center gap-1.5"
            title="Ersätter all kontors- och mäklardata"
          >
            <ArrowsClockwise size={14} className={syncing ? "animate-spin" : ""} />
            {syncing ? "Synkar alla kontor…" : "Full sync (alla 90 kontor)"}
          </button>
        </div>
      </header>

      <section className="card-surface p-6">
        <div className="overline mb-2">Senaste körning</div>
        {!lastRun && <div className="text-sm text-[#52525B] font-body">Ingen körning ännu.</div>}
        {lastRun && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-6">
            <div>
              <div className="text-[11px] text-[#A1A1AA] uppercase tracking-wider font-display font-bold">Status</div>
              <div className="mt-1.5 inline-flex items-center gap-1.5 px-2 py-1 rounded font-display font-bold text-[12px]"
                   style={{ background: badge.bg, color: badge.fg }}>
                <badge.Icon size={12} weight="duotone" /> {badge.label}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-[#A1A1AA] uppercase tracking-wider font-display font-bold">Hittade</div>
              <div className="font-display font-extrabold text-2xl tabular-nums">{lastRun.offices_found}</div>
            </div>
            <div>
              <div className="text-[11px] text-[#A1A1AA] uppercase tracking-wider font-display font-bold">Hämtade</div>
              <div className="font-display font-extrabold text-2xl tabular-nums">{lastRun.offices_parsed}</div>
            </div>
            <div>
              <div className="text-[11px] text-[#A1A1AA] uppercase tracking-wider font-display font-bold">Startad</div>
              <div className="text-sm font-body">{formatDateTime(lastRun.started_at)}</div>
            </div>
            <div>
              <div className="text-[11px] text-[#A1A1AA] uppercase tracking-wider font-display font-bold">Slutförd</div>
              <div className="text-sm font-body">{formatDateTime(lastRun.finished_at)}</div>
            </div>
          </div>
        )}
        {lastRun?.errors?.length > 0 && (
          <div className="mt-4 p-3 bg-[#FEF2F2] border border-[#FECACA] rounded text-[13px] text-[#7F1D1D] font-body">
            {lastRun.errors.join(" · ")}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <div className="overline">Live-fångst</div>
            <h2 className="font-display font-extrabold tracking-tight text-2xl mt-1">
              Senast skrapade kontor
            </h2>
          </div>
          <div className="text-xs text-[#52525B] font-body">{discovered.length} kontor</div>
        </div>
        {!discovered.length ? (
          <div className="card-surface p-8 text-center text-sm text-[#A1A1AA] font-body" data-testid="no-discovered">
            Inga kontor skrapade ännu. Kör en scrape för att hämta live-data.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {discovered.map((o, i) => (
              <div key={o.url} className="card-surface p-4" data-testid={`discovered-${i}`}>
                <div className="font-display font-extrabold text-[15px] text-[#0A0A0A] leading-tight">{o.name}</div>
                <div className="text-[12px] text-[#52525B] font-body mt-0.5">{o.city || "—"}</div>
                <div className="text-[12px] text-[#52525B] font-body mt-2">{o.address || "Adress saknas"}</div>
                <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#52525B] font-body">
                  {o.phone && <span>📞 {o.phone}</span>}
                  {o.email && <span>✉ {o.email}</span>}
                  <span>{o.brokers?.length || 0} mäklare hittade</span>
                </div>
                <a href={o.url} target="_blank" rel="noreferrer" className="text-[11px] text-[#CBA135] font-display font-bold mt-2 inline-block">
                  Öppna på skandiamaklarna.se →
                </a>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
```


### `frontend/src/pages/Settings.jsx`

```jsx
import { useEffect, useState } from "react";
import { Plus, Target, Trash, FloppyDisk, EnvelopeSimple } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, formatDate } from "../lib/api";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

export default function Settings() {
  const [goals, setGoals] = useState([]);
  const [dueReminders, setDueReminders] = useState([]);
  const [newGoal, setNewGoal] = useState({ title: "", target: 5, current: 0, metric: "", deadline: "" });

  const load = async () => {
    const [g, d] = await Promise.all([
      api.get("/goals"),
      api.get("/reminders/due", { params: { days_ahead: 14 } }),
    ]);
    setGoals(g.data.items || []);
    setDueReminders(d.data.items || []);
  };
  useEffect(() => { load(); }, []);

  const updateField = async (id, field, value) => {
    try {
      await api.patch(`/goals/${id}`, { [field]: value });
      load();
    } catch (e) {
      toast.error("Fel: " + e.message);
    }
  };

  const create = async () => {
    if (!newGoal.title.trim()) { toast.error("Titel krävs"); return; }
    try {
      await api.post("/goals", {
        title: newGoal.title,
        target: Number(newGoal.target) || 1,
        current: Number(newGoal.current) || 0,
        metric: newGoal.metric,
        deadline: newGoal.deadline || null,
      });
      setNewGoal({ title: "", target: 5, current: 0, metric: "", deadline: "" });
      toast.success("Mål skapat");
      load();
    } catch (e) {
      toast.error("Fel: " + e.message);
    }
  };

  const remove = async (id) => {
    if (!confirm("Ta bort mål?")) return;
    await api.delete(`/goals/${id}`);
    load();
  };

  const sendReminder = async (pid) => {
    const res = await api.post("/reminders/send", { prospect_id: pid });
    if (res.data.status === "success") toast.success(res.data.message);
    else if (res.data.status === "skipped") toast.warning(res.data.message);
    else toast.error(res.data.message);
  };

  return (
    <div data-testid="settings-page" className="flex flex-col gap-8">
      <header>
        <div className="overline">Konfiguration</div>
        <h1 className="font-display font-extrabold tracking-tighter text-4xl mt-1">
          Mål & Inställningar
        </h1>
      </header>

      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="overline">Etableringsmål</div>
            <h2 className="font-display font-extrabold tracking-tight text-2xl mt-1 flex items-center gap-2">
              <Target size={20} color="#CBA135" weight="duotone" /> Mål vs utfall
            </h2>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          {goals.map((g) => {
            const pct = Math.min(100, Math.round((g.current / Math.max(g.target, 1)) * 100));
            return (
              <div key={g.id} className="card-surface p-5" data-testid={`goal-card-${g.id}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <Input
                      defaultValue={g.title}
                      onBlur={(e) => e.target.value !== g.title && updateField(g.id, "title", e.target.value)}
                      className="input-base font-display font-bold text-[14px] !p-2"
                    />
                  </div>
                  <button onClick={() => remove(g.id)} className="btn-ghost p-1.5 text-[#DC2626]">
                    <Trash size={14} />
                  </button>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <div className="flex-1">
                    <div className="text-[11px] text-[#A1A1AA] uppercase tracking-wider font-display font-bold">Aktuellt</div>
                    <Input
                      type="number"
                      defaultValue={g.current}
                      onBlur={(e) => Number(e.target.value) !== g.current && updateField(g.id, "current", Number(e.target.value))}
                      className="input-base mt-1 !p-2 font-display font-bold text-xl"
                    />
                  </div>
                  <div className="flex-1">
                    <div className="text-[11px] text-[#A1A1AA] uppercase tracking-wider font-display font-bold">Mål</div>
                    <Input
                      type="number"
                      defaultValue={g.target}
                      onBlur={(e) => Number(e.target.value) !== g.target && updateField(g.id, "target", Number(e.target.value))}
                      className="input-base mt-1 !p-2 font-display font-bold text-xl"
                    />
                  </div>
                </div>
                <div className="mt-3 h-2 bg-[#F4F4F5] rounded-full overflow-hidden">
                  <div className="h-full bg-[#CBA135]" style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-2 flex justify-between text-[12px] font-body text-[#52525B]">
                  <span>{g.metric || "—"}</span>
                  <span>Deadline {formatDate(g.deadline)}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="card-surface p-5">
          <div className="overline mb-3">Nytt mål</div>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <Input
              data-testid="new-goal-title"
              placeholder="Titel (t.ex. 5 nya kontor Q2)"
              className="input-base md:col-span-2"
              value={newGoal.title}
              onChange={(e) => setNewGoal({ ...newGoal, title: e.target.value })}
            />
            <Input
              type="number"
              placeholder="Mål"
              className="input-base"
              value={newGoal.target}
              onChange={(e) => setNewGoal({ ...newGoal, target: e.target.value })}
            />
            <Input
              type="number"
              placeholder="Nuvarande"
              className="input-base"
              value={newGoal.current}
              onChange={(e) => setNewGoal({ ...newGoal, current: e.target.value })}
            />
            <Input
              type="date"
              className="input-base"
              value={newGoal.deadline}
              onChange={(e) => setNewGoal({ ...newGoal, deadline: e.target.value })}
            />
            <Input
              placeholder="Mätetal"
              className="input-base md:col-span-2"
              value={newGoal.metric}
              onChange={(e) => setNewGoal({ ...newGoal, metric: e.target.value })}
            />
            <button
              data-testid="create-goal-btn"
              onClick={create}
              className="btn-primary inline-flex items-center gap-1.5 md:col-span-3"
            >
              <Plus size={14} /> Lägg till mål
            </button>
          </div>
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="overline">Påminnelser</div>
            <h2 className="font-display font-extrabold tracking-tight text-2xl mt-1 flex items-center gap-2">
              <EnvelopeSimple size={20} color="#CBA135" weight="duotone" /> Nästa 14 dagar
            </h2>
          </div>
        </div>
        {dueReminders.length === 0 ? (
          <div className="card-surface p-8 text-center text-sm text-[#A1A1AA] font-body">
            Inga uppföljningar planerade.
          </div>
        ) : (
          <div className="card-surface divide-y divide-[#E5E5E5]">
            {dueReminders.map((p) => (
              <div key={p.id} className="p-4 flex items-center justify-between gap-4" data-testid={`due-${p.id}`}>
                <div>
                  <div className="font-display font-bold text-[14px]">{p.name}</div>
                  <div className="text-[12px] text-[#52525B] font-body">
                    {p.next_step || "Uppföljning"} · {p.city || "—"}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-[12px] font-display font-bold text-[#CBA135]">
                    {formatDate(p.next_step_date)}
                  </div>
                  <button
                    onClick={() => sendReminder(p.id)}
                    className="btn-secondary inline-flex items-center gap-1 text-[12px]"
                  >
                    <EnvelopeSimple size={12} /> Skicka mejl
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card-surface p-6">
        <div className="overline mb-2">Integrationer</div>
        <ul className="text-sm font-body space-y-2 text-[#52525B]">
          <li><strong className="text-[#0A0A0A] font-display">AI research:</strong> Emergent LLM key (Claude Sonnet 4.5) — aktiv.</li>
          <li><strong className="text-[#0A0A0A] font-display">E-postpåminnelser:</strong> Resend — kräver <code className="bg-[#F4F4F5] px-1.5 py-0.5 rounded font-mono">RESEND_API_KEY</code> och <code className="bg-[#F4F4F5] px-1.5 py-0.5 rounded font-mono">REMINDER_RECIPIENT</code> i backend/.env.</li>
          <li><strong className="text-[#0A0A0A] font-display">Karttiles:</strong> CartoDB Positron (ingen API-nyckel).</li>
          <li><strong className="text-[#0A0A0A] font-display">Scraping-källa:</strong> skandiamaklarna.se (live).</li>
        </ul>
      </section>
    </div>
  );
}
```


### `frontend/src/pages/Team.jsx`

```jsx
import { useEffect, useState } from "react";
import { Plus, Trash, Crown, User as UserIcon, Shield } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useAuth, formatApiError } from "../lib/auth";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { formatDate } from "../lib/api";

const empty = { email: "", name: "", password: "", role: "member" };

export default function Team() {
  const { user } = useAuth();
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const isAdmin = user?.role === "admin";

  const load = async () => {
    const res = await api.get("/users");
    setUsers(res.data.items || []);
  };
  useEffect(() => { load(); }, []);

  const create = async (e) => {
    e.preventDefault();
    if (!form.email || !form.name || !form.password) {
      toast.error("E-post, namn och lösenord krävs");
      return;
    }
    setBusy(true);
    try {
      await api.post("/users", form);
      toast.success(`Användare ${form.name} skapad`);
      setForm(empty);
      load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || err.message);
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (u, newRole) => {
    try {
      await api.patch(`/users/${u.id}`, { role: newRole });
      toast.success(`${u.name} är nu ${newRole}`);
      load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || err.message);
    }
  };

  const remove = async (u) => {
    if (!confirm(`Ta bort ${u.name}? Deras prospekt blir otilldelade.`)) return;
    try {
      await api.delete(`/users/${u.id}`);
      toast.success(`${u.name} borttagen`);
      load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || err.message);
    }
  };

  return (
    <div data-testid="team-page" className="flex flex-col gap-6">
      <header>
        <div className="overline">Team</div>
        <h1 className="font-display font-extrabold tracking-tighter text-4xl mt-1">
          Mitt team
        </h1>
        <p className="text-[#52525B] text-sm mt-2 font-body max-w-2xl">
          {users.length} användare. {isAdmin
            ? "Du kan bjuda in kollegor och ändra roller."
            : "Endast admin kan bjuda in nya användare."}
        </p>
      </header>

      {isAdmin && (
        <section className="card-surface p-5">
          <div className="overline mb-3">Bjud in kollega</div>
          <form onSubmit={create} className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <Input
              data-testid="invite-name"
              placeholder="Namn"
              className="input-base"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Input
              data-testid="invite-email"
              type="email"
              placeholder="E-post"
              className="input-base md:col-span-2"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <Input
              data-testid="invite-password"
              type="text"
              placeholder="Tillfälligt lösenord"
              className="input-base"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
              <SelectTrigger data-testid="invite-role" className="input-base">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Medlem</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
            <button
              data-testid="invite-submit"
              type="submit"
              disabled={busy}
              className="btn-primary inline-flex items-center justify-center gap-1.5 md:col-span-5"
            >
              <Plus size={14} /> {busy ? "Skapar…" : "Skapa konto"}
            </button>
          </form>
          <p className="mt-3 text-[11px] text-[#A1A1AA] font-body">
            Det tillfälliga lösenordet behöver du dela manuellt med kollegan. De kan byta det själva
            (kommer i nästa version) eller be dig återställa det.
          </p>
        </section>
      )}

      <div className="card-surface overflow-hidden">
        <Table data-testid="users-table">
          <TableHeader>
            <TableRow className="bg-[#FAFAFA]">
              <TableHead className="overline">Namn</TableHead>
              <TableHead className="overline">E-post</TableHead>
              <TableHead className="overline">Roll</TableHead>
              <TableHead className="overline">Skapad</TableHead>
              <TableHead className="overline w-20"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id} className="row-hover" data-testid={`user-row-${u.id}`}>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-full bg-[#F4F4F5] border border-[#E5E5E5] flex items-center justify-center">
                      {u.role === "admin" ? (
                        <Crown size={14} color="#CBA135" weight="duotone" />
                      ) : (
                        <UserIcon size={14} color="#52525B" />
                      )}
                    </div>
                    <div className="font-display font-bold text-sm">
                      {u.name}
                      {u.id === user?.id && (
                        <span className="ml-2 text-[10px] uppercase tracking-wider text-[#CBA135] font-display font-bold">
                          (du)
                        </span>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-sm font-body text-[#52525B]">{u.email}</TableCell>
                <TableCell>
                  {isAdmin && u.id !== user?.id ? (
                    <Select value={u.role} onValueChange={(v) => changeRole(u, v)}>
                      <SelectTrigger className="input-base !p-1.5 h-auto w-32 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">Medlem</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <span
                      className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-display font-bold px-2 py-0.5 rounded"
                      style={{
                        background: u.role === "admin" ? "#0A0A0A" : "#F4F4F5",
                        color: u.role === "admin" ? "#CBA135" : "#52525B",
                      }}
                    >
                      <Shield size={10} weight="duotone" /> {u.role}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-sm font-body text-[#52525B]">{formatDate(u.created_at)}</TableCell>
                <TableCell>
                  {isAdmin && u.id !== user?.id && (
                    <button
                      onClick={() => remove(u)}
                      className="btn-ghost p-1.5 text-[#DC2626]"
                      data-testid={`delete-user-${u.id}`}
                    >
                      <Trash size={14} />
                    </button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!users.length && (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-12 text-[#A1A1AA] text-sm">
                  Inga användare hittade.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
```


---

# TESTS

## `backend/tests/test_office_coupling.py`

```python
"""Tests for explicit office-coupling feature on prospects.

Covers:
- POST /api/prospects with office_id sets office_name automatically
- PATCH /api/prospects/{id} with office_id updates both fields; empty string clears
- GET /api/offices/{id} returns prospects linked via office_id AND legacy city-matched (no dups)
- GET /api/dashboard/office-recruitment counts explicit office-linked prospects correctly
- POST /api/offices/{id}/link-city-prospects bulk-links city-matched prospects
- Activity log writes 'office_linked' entry on office_id change
- Regression: create/update without office_id still works
"""
from __future__ import annotations
import os
import pytest
import requests

BASE = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE}/api"
ADMIN_EMAIL = "delfi@skandiamaklarna.se"
ADMIN_PASS = "Etablering2026"


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASS})
    if r.status_code != 200:
        pytest.skip(f"Login failed: {r.status_code} {r.text}")
    return s


@pytest.fixture(scope="module")
def two_offices(client):
    r = client.get(f"{API}/offices")
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) >= 2, "Need at least 2 seeded offices"
    return items[0], items[1]


@pytest.fixture
def cleanup(client):
    created = []
    yield created
    for pid in created:
        client.delete(f"{API}/prospects/{pid}")


class TestCreateWithOffice:
    def test_create_with_office_id_sets_name(self, client, two_offices, cleanup):
        o1, _ = two_offices
        payload = {
            "name": "TEST_OfficeCoupling Create",
            "type": "broker",
            "current_agency": "Fastighetsbyrån",
            "city": "Annan Stad",
            "status": "Identifierad",
            "office_id": o1["id"],
        }
        r = client.post(f"{API}/prospects", json=payload)
        assert r.status_code == 200, r.text
        d = r.json()
        cleanup.append(d["id"])
        assert d["office_id"] == o1["id"]
        assert d["office_name"] == o1["name"]
        # Verify persistence
        r = client.get(f"{API}/prospects/{d['id']}")
        assert r.status_code == 200
        assert r.json()["office_name"] == o1["name"]

    def test_create_without_office_id_regression(self, client, cleanup):
        payload = {
            "name": "TEST_NoOffice",
            "type": "broker",
            "current_agency": "Bjurfors",
            "city": "Lund",
            "status": "Identifierad",
        }
        r = client.post(f"{API}/prospects", json=payload)
        assert r.status_code == 200, r.text
        d = r.json()
        cleanup.append(d["id"])
        assert d.get("office_id") in (None, "")
        assert d.get("office_name", "") == ""


class TestPatchOffice:
    def test_patch_sets_and_clears_office(self, client, two_offices, cleanup):
        o1, o2 = two_offices
        # Start without office
        r = client.post(f"{API}/prospects", json={
            "name": "TEST_PatchOffice",
            "type": "broker", "current_agency": "X", "city": "Y",
            "status": "Identifierad",
        })
        assert r.status_code == 200
        pid = r.json()["id"]
        cleanup.append(pid)

        # PATCH set office_id → o1
        r = client.patch(f"{API}/prospects/{pid}", json={"office_id": o1["id"]})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["office_id"] == o1["id"]
        assert d["office_name"] == o1["name"]

        # PATCH change to o2
        r = client.patch(f"{API}/prospects/{pid}", json={"office_id": o2["id"]})
        assert r.status_code == 200
        assert r.json()["office_name"] == o2["name"]

        # PATCH clear with empty string
        r = client.patch(f"{API}/prospects/{pid}", json={"office_id": ""})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("office_id") in (None, "")
        assert d.get("office_name", "") == ""

        # Verify GET shows cleared
        r = client.get(f"{API}/prospects/{pid}")
        assert r.json().get("office_name", "") == ""

    def test_activity_office_linked_entry(self, client, two_offices, cleanup):
        o1, _ = two_offices
        r = client.post(f"{API}/prospects", json={
            "name": "TEST_ActivityOfficeLink",
            "type": "broker", "current_agency": "X", "city": "Z",
            "status": "Identifierad",
        })
        pid = r.json()["id"]
        cleanup.append(pid)

        r = client.patch(f"{API}/prospects/{pid}", json={"office_id": o1["id"]})
        assert r.status_code == 200

        r = client.get(f"{API}/activity", params={"limit": 50})
        items = r.json()["items"]
        msgs = [(a.get("kind"), a.get("message", "")) for a in items]
        # Look for office_linked entry referencing prospect name
        found = any(t == "office_linked" and "TEST_ActivityOfficeLink" in m for t, m in msgs)
        assert found, f"office_linked activity entry missing. Got: {msgs[:8]}"


class TestOfficeDetailListsProspects:
    def test_get_office_includes_explicit_and_city_prospects(self, client, two_offices, cleanup):
        o1, _ = two_offices
        city = o1.get("city") or "Stockholm"

        # Prospect 1: explicit office_id, different city
        r1 = client.post(f"{API}/prospects", json={
            "name": "TEST_ExplicitOffice",
            "type": "broker", "current_agency": "A",
            "city": "Annan Stad Helt",  # not matching
            "status": "Identifierad",
            "office_id": o1["id"],
        })
        cleanup.append(r1.json()["id"])

        # Prospect 2: legacy — no office_id but matching city
        r2 = client.post(f"{API}/prospects", json={
            "name": "TEST_LegacyCity",
            "type": "broker", "current_agency": "B",
            "city": city,
            "status": "Identifierad",
        })
        cleanup.append(r2.json()["id"])

        r = client.get(f"{API}/offices/{o1['id']}")
        assert r.status_code == 200
        prospects = r.json()["prospects"]
        names = [p["name"] for p in prospects]
        assert "TEST_ExplicitOffice" in names
        assert "TEST_LegacyCity" in names
        # No duplicates by id
        ids = [p["id"] for p in prospects]
        assert len(ids) == len(set(ids))


class TestOfficeRecruitmentDashboard:
    def test_explicit_office_counted(self, client, two_offices, cleanup):
        o1, _ = two_offices

        # Get baseline counts
        r = client.get(f"{API}/dashboard/office-recruitment")
        assert r.status_code == 200
        rows = r.json()["rows"]
        baseline_row = next(x for x in rows if x["office_id"] == o1["id"])
        base_pipeline = baseline_row["in_pipeline"]
        base_signed = baseline_row["current_hires"]

        # Add a Signerad prospect via explicit office_id (different city)
        r = client.post(f"{API}/prospects", json={
            "name": "TEST_Recruit_Signed",
            "type": "broker", "current_agency": "X",
            "city": "Unrelated City",
            "status": "Signerad",
            "office_id": o1["id"],
        })
        cleanup.append(r.json()["id"])

        # Add an active prospect via explicit office
        r = client.post(f"{API}/prospects", json={
            "name": "TEST_Recruit_Active",
            "type": "broker", "current_agency": "X",
            "city": "Unrelated City",
            "status": "Kontaktad",
            "office_id": o1["id"],
        })
        cleanup.append(r.json()["id"])

        r = client.get(f"{API}/dashboard/office-recruitment")
        rows = r.json()["rows"]
        row = next(x for x in rows if x["office_id"] == o1["id"])
        assert row["current_hires"] == base_signed + 1, "Signerad explicit-office prospect not counted"
        assert row["in_pipeline"] >= base_pipeline + 2, \
            "Active explicit-office prospects not in pipeline count"


class TestLinkCityProspects:
    def test_bulk_link_assigns_legacy_prospects(self, client, two_offices, cleanup):
        o1, _ = two_offices
        city = o1.get("city")
        if not city:
            pytest.skip("Office has no city")

        # Create a legacy prospect without office_id
        r = client.post(f"{API}/prospects", json={
            "name": "TEST_BulkLink",
            "type": "broker", "current_agency": "X",
            "city": city,
            "status": "Identifierad",
        })
        pid = r.json()["id"]
        cleanup.append(pid)
        assert r.json().get("office_id") in (None, "")

        # Run bulk link
        r = client.post(f"{API}/offices/{o1['id']}/link-city-prospects", json={})
        assert r.status_code == 200, r.text
        assert r.json()["linked"] >= 1

        # Verify the prospect now has explicit office_id
        r = client.get(f"{API}/prospects/{pid}")
        assert r.json()["office_id"] == o1["id"]
        assert r.json()["office_name"] == o1["name"]
```


---
**Total filer inkluderade:** 35
