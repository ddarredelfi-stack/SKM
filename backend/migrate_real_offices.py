"""Migrate an EXISTING (already-seeded) database to the real kontorslista data.

_ensure_seed() in server.py only seeds offices/brokers/listings when the
`offices` collection is completely empty — so if you've already been running
the app (e.g. on Emergent, or locally), this script is how you swap the old
placeholder office list for the real one without losing prospects/goals/
activity you've already created.

What it does:
  1. Backs up the current `offices`, `brokers`, `listings` collections to a
     timestamped JSON file in this directory.
  2. Builds the new offices/brokers/listings from real_offices_data.py
     (same generator as a fresh seed — see seed_data.build_seed()).
  3. Best-effort relinks existing `prospects` / `office_goals` whose
     office_id points at an old office to the new office with the same
     city (case-insensitive). If no match is found, office_id is cleared
     (the app already falls back to matching prospects by city string, so
     nothing is lost — it just becomes an implicit link instead of explicit).
  4. Replaces the offices/brokers/listings collections.

By default this is a DRY RUN — it prints exactly what it would do and writes
the backup, but does not touch the database. Pass --apply to actually write.

Usage:
    python migrate_real_offices.py            # dry run
    python migrate_real_offices.py --apply     # actually migrate
"""
from __future__ import annotations
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

from seed_data import build_seed  # noqa: E402


def _norm(s: str | None) -> str:
    return (s or "").strip().lower()


async def main():
    apply = "--apply" in sys.argv

    mongo_url = os.environ["MONGO_URL"]
    db_name = os.environ["DB_NAME"]
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    old_offices = [o async for o in db.offices.find({}, {"_id": 0})]
    old_brokers_count = await db.brokers.count_documents({})
    old_listings_count = await db.listings.count_documents({})
    print(f"Current DB '{db_name}': {len(old_offices)} offices, "
          f"{old_brokers_count} brokers, {old_listings_count} listings")

    if not old_offices:
        print("Offices collection is empty — nothing to migrate. "
              "Just start the app normally; _ensure_seed() will seed the "
              "real data automatically on first startup.")
        return

    # 1) Backup
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup_path = ROOT_DIR / f"backup_offices_{ts}.json"
    old_brokers = [b async for b in db.brokers.find({}, {"_id": 0})]
    old_listings = [l async for l in db.listings.find({}, {"_id": 0})]
    with open(backup_path, "w", encoding="utf-8") as f:
        json.dump(
            {"offices": old_offices, "brokers": old_brokers, "listings": old_listings},
            f, ensure_ascii=False, indent=2, default=str,
        )
    print(f"Backup written to {backup_path}")

    # 2) Build new data
    new_offices, new_brokers, new_listings = build_seed()
    print(f"New dataset: {len(new_offices)} offices, {len(new_brokers)} brokers, "
          f"{len(new_listings)} listings")

    # 3) Relink prospects / office_goals by matching city
    old_id_to_city = {o["id"]: _norm(o.get("city")) for o in old_offices}
    new_city_to_office = {}
    for o in new_offices:
        new_city_to_office.setdefault(_norm(o.get("city")), o)

    prospects_with_office = [p async for p in db.prospects.find(
        {"office_id": {"$nin": [None, ""]}}, {"_id": 0, "id": 1, "office_id": 1, "name": 1}
    )]
    goals_with_office = [g async for g in db.office_goals.find({}, {"_id": 0, "id": 1, "office_id": 1})]

    relink_plan = []  # (collection, doc_id, new_office_id_or_None, new_office_name_or_None)
    relinked, cleared = 0, 0
    for p in prospects_with_office:
        city = old_id_to_city.get(p["office_id"])
        match = new_city_to_office.get(city) if city else None
        if match:
            relink_plan.append(("prospects", p["id"], match["id"], match["name"]))
            relinked += 1
        else:
            relink_plan.append(("prospects", p["id"], None, None))
            cleared += 1
    goal_plan = []
    for g in goals_with_office:
        city = old_id_to_city.get(g["office_id"])
        match = new_city_to_office.get(city) if city else None
        if match:
            goal_plan.append((g["id"], match["id"]))

    print(f"Prospects linked to an office: {len(prospects_with_office)} "
          f"→ {relinked} relinked to matching city, {cleared} cleared (falls back to city text-match)")
    print(f"Office goals linked to an office: {len(goals_with_office)} "
          f"→ {len(goal_plan)} relinked, {len(goals_with_office) - len(goal_plan)} will be orphaned "
          f"(goal for an office that no longer exists by that city — safe to delete manually if unwanted)")

    if not apply:
        print("\nDRY RUN — no changes written. Re-run with --apply to migrate for real.")
        return

    # 4) Apply
    for coll, doc_id, new_office_id, new_office_name in relink_plan:
        await db.prospects.update_one(
            {"id": doc_id},
            {"$set": {"office_id": new_office_id, "office_name": new_office_name}},
        )
    for goal_id, new_office_id in goal_plan:
        await db.office_goals.update_one({"id": goal_id}, {"$set": {"office_id": new_office_id}})

    await db.offices.delete_many({})
    await db.brokers.delete_many({})
    await db.listings.delete_many({})
    if new_offices:
        await db.offices.insert_many(new_offices)
    if new_brokers:
        await db.brokers.insert_many(new_brokers)
    if new_listings:
        await db.listings.insert_many(new_listings)

    print(f"\nDone. Offices/brokers/listings replaced with the real kontorslista dataset. "
          f"Backup of the old data is at {backup_path} if you need to roll back.")


if __name__ == "__main__":
    asyncio.run(main())
