"""Realistic seed data for Skandiamäklarna offices, brokers and active listings.

This represents a snapshot of the network used as the initial baseline. The
'Refresh scrape' endpoint will attempt to update / augment this with live data
from skandiamaklarna.se when triggered.
"""
from __future__ import annotations
import uuid
import random
from datetime import datetime, timezone, timedelta

from real_offices_data import REAL_OFFICES, EXTRA_UNITS  # noqa: E402


def _id() -> str:
    return str(uuid.uuid4())


AVATAR_M = "https://images.unsplash.com/photo-1560250097-0b93528c311a?crop=entropy&cs=srgb&fm=jpg&w=400&q=80"
AVATAR_F = "https://images.unsplash.com/photo-1494790108377-be9c29b29330?crop=entropy&cs=srgb&fm=jpg&w=400&q=80"
AVATAR_F2 = "https://images.unsplash.com/photo-1685760259914-ee8d2c92d2e0?crop=entropy&cs=srgb&fm=jpg&w=400&q=80"
AVATAR_M2 = "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?crop=entropy&cs=srgb&fm=jpg&w=400&q=80"
AVATAR_F3 = "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?crop=entropy&cs=srgb&fm=jpg&w=400&q=80"


# Legacy fictional seed sample — superseded by REAL_OFFICES (see
# real_offices_data.py, sourced from the actual Skandiamäklarna kontorslista).
# Kept only for reference / rollback, no longer used by build_seed().
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
    """Build offices/brokers/listings from the REAL office list (kontorslista).

    Office identity fields we don't have (exact street address, phone, named
    kontorschef) get a placeholder until either a live scrape fills them in
    or someone edits them by hand. Mäklare/listings are still generated
    (no public roster in the source data), but broker_count is scaled to the
    office's actual 'sålda objekt' so bigger/busier offices get more people
    instead of a flat random range.
    """
    random.seed(42)
    offices, brokers, listings = [], [], []
    now = datetime.now(timezone.utc).isoformat()

    for perf in REAL_OFFICES:
        name = perf["name"]
        city = perf["city"]
        region = perf["region"]
        lat, lng = perf["lat"], perf["lng"]
        office_id = _id()
        slug = (name.lower().replace("skandiamäklarna ", "")
                .replace("/", "-").replace(" ", "-")
                .replace("å", "a").replace("ä", "a").replace("ö", "o"))

        broker_count = max(2, min(18, round((perf["sald"] or 0) / 7))) or random.randint(2, 5)
        office_brokers = []
        for i in range(broker_count):
            is_f = random.random() > 0.45
            first = random.choice(_FIRSTNAMES_F if is_f else _FIRSTNAMES_M)
            last = random.choice(_LASTNAMES)
            full = f"{first} {last}"
            broker_id = _id()
            title = "Kontorschef" if i == 0 else random.choice(TITLES)
            avatar = random.choice([AVATAR_F, AVATAR_F2, AVATAR_F3]) if is_f else random.choice([AVATAR_M, AVATAR_M2])
            office_brokers.append({
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

        brokers.extend(office_brokers)
        manager = office_brokers[0]["name"] if office_brokers else ""

        offices.append({
            "id": office_id,
            "name": name,
            "city": city,
            "region": region,
            "address": "",  # okänd — komplettera manuellt eller via scrape
            "phone": "",
            "manager": manager,
            "lat": lat,
            "lng": lng,
            "email": f"{slug}@skandiamaklarna.se",
            "website": f"https://www.skandiamaklarna.se/maklare/{slug}",
            "source": "kontorslista_2026",
            "scraped_at": now,
            # --- Prestandadata från kontorslistan (Excel, period 250101-250618) ---
            "kategori": perf["kategori"],
            "prio": perf["prio"],
            "prio_num": perf["prio_num"],
            "oms": perf["oms"],
            "oms_fjol": perf["oms_fjol"],
            "sald": perf["sald"],
            "sald_fjol": perf["sald_fjol"],
            "yoy_pct": perf["yoy_pct"],
            "kommentar": perf["kommentar"],
            "recommended_action": perf["recommended_action"],
        })

    return offices, brokers, listings


def get_extra_units():
    """Kommersiella / vilande enheter utan tilldelad prio i kontorslistan.

    Not seeded as full office documents (no operational kontor, no
    kontorschef/mäklare workflow) — just exposed read-only for reference.
    """
    return EXTRA_UNITS


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
