"""Reparera kontorslista-data efter scrape-synk.

Den första synken matchade prestandadata (kategori/prio/omsättning) på ORT,
vilket blev fel eftersom skandiamaklarna.se anger postort — Malmös siffror
spreds till Lomma/Lund/Staffanstorp, Solna fick Sundbybergs data, och flera
kontor tappade sin data helt.

Det här skriptet återställer allt korrekt från real_offices_data.py (som
innehåller hela original-kontorslistan) genom NAMN-matchning:

  1. Rensar prestandafälten på ALLA kontor i databasen (tar bort felspridd data)
  2. Matchar kontorslistans 80 kontor mot de skrapade kontorens namn
  3. Skriver tillbaka kategori/prio/omsättning/kommentar/åtgärd på rätt kontor

Kör:  ./venv/bin/python fix_kontorslista.py
(Säkert att köra flera gånger.)
"""
from __future__ import annotations
import asyncio
import os
from pathlib import Path

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

from kontorslista_match import PERF_FIELDS, match_offices, norm_name  # noqa: E402
from real_offices_data import REAL_OFFICES  # noqa: E402


async def main():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]

    offices = [o async for o in db.offices.find({}, {"_id": 0, "id": 1, "name": 1, "city": 1})]
    if not offices:
        print("Inga kontor i databasen — kör en Full sync i appen först.")
        return
    print(f"{len(offices)} kontor i databasen.")

    # 1) Rensa alla prestandafält (tar bort felspridd data)
    unset = {f: "" for f in PERF_FIELDS}
    res = await db.offices.update_many({}, {"$unset": unset})
    print(f"Rensade prestandafält på {res.modified_count} kontor.")

    # 2) Matcha kontorslistan mot de skrapade kontorens namn
    kl_names = [o["city"] for o in REAL_OFFICES]  # kortnamn ("Malmö", "Stockholm Vasastan", ...)
    scraped_names = [o.get("name", "") for o in offices]
    mapping = match_offices(kl_names, scraped_names)

    office_by_norm = {norm_name(o.get("name", "")): o for o in offices}
    perf_by_norm = {norm_name(o["city"]): o for o in REAL_OFFICES}

    applied, missed = 0, []
    for kl_norm, scraped_norm in mapping.items():
        perf = perf_by_norm.get(kl_norm)
        target = office_by_norm.get(scraped_norm)
        if not perf or not target:
            missed.append(kl_norm)
            continue
        await db.offices.update_one(
            {"id": target["id"]},
            {"$set": {f: perf.get(f) for f in PERF_FIELDS if f in perf or f == "region"}
                     | {"region": perf.get("region")}},
        )
        applied += 1

    unmatched = [n for n in kl_names if norm_name(n) not in mapping]
    print(f"Prestandadata återställd på {applied} kontor.")
    if unmatched:
        print(f"Utan motsvarighet på skandiamaklarna.se (vilande, data ej applicerad): {unmatched}")
    if missed:
        print(f"VARNING — kunde inte applicera: {missed}")

    # 3) Sanity: Prio 1-räkning + stickprov Solna
    prio1 = await db.offices.count_documents({"prio": "1"})
    solna = await db.offices.find_one({"name": {"$regex": "Solna", "$options": "i"}}, {"_id": 0, "name": 1, "oms": 1, "yoy_pct": 1, "kategori": 1})
    print(f"Prio 1-kontor nu: {prio1}")
    if solna:
        print(f"Stickprov Solna: {solna}")
    print("Klart! Ladda om appen i webbläsaren.")


if __name__ == "__main__":
    asyncio.run(main())
