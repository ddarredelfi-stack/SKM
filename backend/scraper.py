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
            "office_id": office_doc["id"],
            "office_name": office_doc["name"],
            "city": office_doc["city"],
            "active_listings": 0,
            "ytd_sales": 0,
            "source": "scrape",
            "scraped_at": _now_iso(),
        })
    return out
