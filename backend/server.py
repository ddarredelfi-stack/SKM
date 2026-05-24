"""Etableringschef-dashboard backend for Skandiamäklarna.

FastAPI + MongoDB, exposes:
- /api/dashboard/kpis
- /api/offices, /api/brokers, /api/listings (read + filters)
- /api/prospects (CRUD + status update)
- /api/activity (activity log)
- /api/goals (CRUD)
- /api/geo/municipalities, /api/geo/whitespots
- /api/scrape/run, /api/scrape/sync, /api/scrape/status
- /api/ai/research-brief
- /api/reminders/send (manual + due reminders)
- /api/export/{type}.csv
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
from fastapi import APIRouter, FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

from ai_service import generate_brief  # noqa: E402
from email_service import build_reminder_html, send_reminder  # noqa: E402
from municipalities_data import MUNICIPALITIES  # noqa: E402
from scraper import scrape_offices, to_broker_docs, to_office_doc  # noqa: E402
from seed_data import (  # noqa: E402
    build_activity_seed,
    build_goals,
    build_prospects,
    build_seed,
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
api = APIRouter(prefix="/api")


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


class StatusUpdate(BaseModel):
    status: str


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
async def _activity(kind: str, message: str, **kwargs: Any):
    doc = {
        "id": _id(),
        "kind": kind,
        "message": message,
        "created_at": _now(),
        "prospect_id": kwargs.get("prospect_id"),
        "prospect_name": kwargs.get("prospect_name"),
        "from_status": kwargs.get("from_status"),
        "to_status": kwargs.get("to_status"),
    }
    await db.activity.insert_one(doc)


def _strip_id(doc: dict) -> dict:
    doc.pop("_id", None)
    return doc


# ---------------------------------------------------------------------------
# Dashboard / KPIs
# ---------------------------------------------------------------------------
@api.get("/dashboard/kpis")
async def kpis():
    offices = await db.offices.count_documents({})
    brokers = await db.brokers.count_documents({})
    listings = await db.listings.count_documents({})
    prospects_total = await db.prospects.count_documents({})

    pipeline = {}
    for s in PIPELINE_STATUSES:
        pipeline[s] = await db.prospects.count_documents({"status": s})

    # Regions covered
    region_cursor = db.offices.aggregate([{"$group": {"_id": "$region"}}])
    regions = [r["_id"] async for r in region_cursor]

    goals = [_strip_id(g) async for g in db.goals.find({}, {"_id": 0})]
    activity = [_strip_id(a) async for a in
                db.activity.find({}, {"_id": 0}).sort("created_at", -1).limit(15)]

    return {
        "offices": offices,
        "brokers": brokers,
        "listings": listings,
        "prospects_total": prospects_total,
        "pipeline": pipeline,
        "regions_covered": len([r for r in regions if r]),
        "goals": goals,
        "activity": activity,
        "as_of": _now(),
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
async def get_office(office_id: str):
    office = await db.offices.find_one({"id": office_id}, {"_id": 0})
    if not office:
        raise HTTPException(404, "Kontor hittades inte")
    brokers = [_strip_id(b) async for b in
               db.brokers.find({"office_id": office_id}, {"_id": 0}).sort("name", 1)]
    listings = [_strip_id(l) async for l in
                db.listings.find({"office_id": office_id}, {"_id": 0}).limit(50)]
    return {"office": office, "brokers": brokers, "listings": listings}


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
async def list_prospects(q: str = "", status: str = "", city: str = ""):
    flt: dict[str, Any] = {}
    if status:
        flt["status"] = status
    if city:
        flt["city"] = city
    if q:
        flt["$or"] = [
            {"name": {"$regex": q, "$options": "i"}},
            {"city": {"$regex": q, "$options": "i"}},
            {"current_agency": {"$regex": q, "$options": "i"}},
            {"email": {"$regex": q, "$options": "i"}},
        ]
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
async def create_prospect(body: ProspectIn):
    if body.status not in PIPELINE_STATUSES:
        raise HTTPException(400, "Ogiltig status")
    doc = body.model_dump()
    doc["id"] = _id()
    doc["created_at"] = _now()
    doc["updated_at"] = _now()
    doc["ai_brief"] = None
    await db.prospects.insert_one(doc)
    await _activity("created", f"Nytt prospekt: {doc['name']}",
                    prospect_id=doc["id"], prospect_name=doc["name"])
    return _strip_id(doc)


@api.get("/prospects/{pid}")
async def get_prospect(pid: str):
    p = await db.prospects.find_one({"id": pid}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Prospekt hittades inte")
    return _strip_id(p)


@api.patch("/prospects/{pid}")
async def update_prospect(pid: str, body: ProspectUpdate):
    existing = await db.prospects.find_one({"id": pid}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Prospekt hittades inte")
    updates = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if "status" in updates and updates["status"] not in PIPELINE_STATUSES:
        raise HTTPException(400, "Ogiltig status")
    updates["updated_at"] = _now()
    await db.prospects.update_one({"id": pid}, {"$set": updates})
    if "status" in updates and updates["status"] != existing.get("status"):
        await _activity("status_change",
                        f"{existing['name']}: {existing.get('status')} → {updates['status']}",
                        prospect_id=pid, prospect_name=existing["name"],
                        from_status=existing.get("status"), to_status=updates["status"])
    p = await db.prospects.find_one({"id": pid}, {"_id": 0})
    return _strip_id(p)


@api.patch("/prospects/{pid}/status")
async def update_status(pid: str, body: StatusUpdate):
    return await update_prospect(pid, ProspectUpdate(status=body.status))


@api.delete("/prospects/{pid}")
async def delete_prospect(pid: str):
    existing = await db.prospects.find_one({"id": pid}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Prospekt hittades inte")
    await db.prospects.delete_one({"id": pid})
    await _activity("deleted", f"Prospekt borttaget: {existing['name']}",
                    prospect_id=pid, prospect_name=existing["name"])
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
# Scrape
# ---------------------------------------------------------------------------
@api.get("/scrape/status")
async def scrape_status():
    last = await db.scrapes.find_one({}, {"_id": 0}, sort=[("started_at", -1)])
    return {"last": last}


@api.post("/scrape/run")
async def scrape_run(limit: int = Query(5, ge=1, le=200)):
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

    await _activity("scrape", f"Scrape körd — {result['offices_parsed']}/{result['offices_found']} kontor hämtade")

    return {**result, "record_id": record["id"]}


@api.post("/scrape/sync")
async def scrape_sync():
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
async def ai_brief(body: ResearchRequest):
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
                        prospect_id=body.prospect_id, prospect_name=body.name)
    return {"brief": brief}


# ---------------------------------------------------------------------------
# Email reminders
# ---------------------------------------------------------------------------
@api.post("/reminders/send")
async def send_reminder_for(body: SendReminderRequest):
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
                    prospect_id=p["id"], prospect_name=p["name"])
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
async def export_offices_csv():
    items = [_strip_id(o) async for o in db.offices.find({}, {"_id": 0}).sort("name", 1)]
    return _csv_response(
        items,
        ["name", "city", "region", "address", "phone", "email", "manager", "website"],
        "skandia-kontor.csv",
    )


@api.get("/export/brokers.csv")
async def export_brokers_csv():
    items = [_strip_id(b) async for b in db.brokers.find({}, {"_id": 0}).sort("name", 1)]
    return _csv_response(
        items,
        ["name", "title", "phone", "email", "office_name", "city", "active_listings", "ytd_sales"],
        "skandia-maklare.csv",
    )


@api.get("/export/prospects.csv")
async def export_prospects_csv():
    items = [_strip_id(p) async for p in db.prospects.find({}, {"_id": 0}).sort("status", 1)]
    return _csv_response(
        items,
        ["name", "type", "status", "current_agency", "city", "region", "phone", "email",
         "linkedin", "next_step", "next_step_date", "notes"],
        "skandia-prospekt.csv",
    )


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@api.get("/")
async def root():
    return {"app": "skandia-etablering", "ok": True, "as_of": _now()}


# ---------------------------------------------------------------------------
# App wiring
# ---------------------------------------------------------------------------
app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown():
    client.close()
