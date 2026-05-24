"""Live scraper for skandiamaklarna.se.

Strategy:
- Fetch the offices listing page and parse office links.
- For each office, fetch the office page and extract address, phone, brokers.
- We use httpx with a realistic UA and conservative concurrency to avoid
  triggering bot protection.

If the structure has changed and we can't parse, we surface the error to the
caller so the dashboard can show a clear status.
"""
from __future__ import annotations
import asyncio
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

BASE_URL = "https://www.skandiamaklarna.se"
OFFICES_URL = f"{BASE_URL}/maklare/kontor/"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")


def _id() -> str:
    return str(uuid.uuid4())


async def _fetch(client: httpx.AsyncClient, url: str) -> Optional[str]:
    try:
        r = await client.get(url, timeout=15.0)
        if r.status_code == 200:
            return r.text
        logger.warning(f"Non-200 from {url}: {r.status_code}")
    except Exception as e:
        logger.warning(f"Fetch failed {url}: {e}")
    return None


def _clean(s: Optional[str]) -> str:
    if not s:
        return ""
    return re.sub(r"\s+", " ", s).strip()


def _parse_offices_index(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    offices = []
    seen = set()
    # Try multiple selectors — site structure can vary
    for a in soup.select("a[href*='/maklare/kontor/']"):
        href = a.get("href", "")
        if not href or href.endswith("/kontor/") or href in seen:
            continue
        if not href.startswith("http"):
            url = BASE_URL + href
        else:
            url = href
        if url in seen:
            continue
        seen.add(url)
        name = _clean(a.get_text())
        if not name or len(name) > 120:
            continue
        offices.append({"url": url, "name_hint": name})
    return offices


def _parse_office_page(url: str, html: str) -> Optional[dict]:
    soup = BeautifulSoup(html, "lxml")
    title_el = soup.select_one("h1") or soup.select_one("title")
    name = _clean(title_el.get_text() if title_el else "")
    if not name:
        return None

    # Phone
    phone = ""
    tel = soup.select_one("a[href^='tel:']")
    if tel:
        phone = _clean(tel.get_text() or tel.get("href", "").replace("tel:", ""))

    # Email
    email = ""
    mail = soup.select_one("a[href^='mailto:']")
    if mail:
        email = _clean(mail.get("href", "").replace("mailto:", ""))

    # Address — try to find a postal-code pattern
    address = ""
    txt = soup.get_text(" ", strip=True)
    m = re.search(r"([A-ZÅÄÖ][\wåäöÅÄÖ\.\- ]+\s+\d+[A-Za-z]?,?\s*\d{3}\s?\d{2}\s+[A-ZÅÄÖ][\wåäöÅÄÖ\- ]+)", txt)
    if m:
        address = _clean(m.group(1))

    # City: take last word of address if present
    city = ""
    if address:
        parts = address.split()
        if len(parts) >= 2:
            city = parts[-1]

    # Brokers — look for cards with broker name + title
    brokers = []
    for card in soup.select("article, .broker, .maklare, [class*='broker'], [class*='maklare']"):
        nm = card.select_one("h2, h3, .name, [class*='name']")
        if not nm:
            continue
        nm_t = _clean(nm.get_text())
        if not nm_t or len(nm_t.split()) > 6:
            continue
        title_el = card.select_one(".title, [class*='title'], .role, [class*='role'], p")
        title = _clean(title_el.get_text()) if title_el else "Reg. fastighetsmäklare"
        ph = card.select_one("a[href^='tel:']")
        ph_v = _clean(ph.get_text() or ph.get("href", "").replace("tel:", "")) if ph else ""
        em = card.select_one("a[href^='mailto:']")
        em_v = _clean(em.get("href", "").replace("mailto:", "")) if em else ""
        img = card.select_one("img")
        avatar = ""
        if img and img.get("src"):
            avatar = img["src"]
            if avatar.startswith("/"):
                avatar = BASE_URL + avatar
        brokers.append({
            "name": nm_t,
            "title": title[:80] if title else "Reg. fastighetsmäklare",
            "phone": ph_v,
            "email": em_v,
            "avatar_url": avatar,
        })

    return {
        "name": name,
        "url": url,
        "address": address,
        "city": city,
        "phone": phone,
        "email": email,
        "brokers": brokers,
    }


async def scrape_offices(limit: int = 5) -> dict:
    """Scrape a small batch of offices from skandiamaklarna.se.

    Returns dict with status, counts, parsed offices and any errors.
    Use a small limit by default since the site may block heavy scraping.
    """
    started = datetime.now(timezone.utc)
    headers = {"User-Agent": UA, "Accept-Language": "sv-SE,sv;q=0.9,en;q=0.8"}
    result = {
        "status": "ok",
        "started_at": started.isoformat(),
        "finished_at": None,
        "offices_found": 0,
        "offices_parsed": 0,
        "errors": [],
        "offices": [],
    }
    try:
        async with httpx.AsyncClient(headers=headers, follow_redirects=True) as client:
            index_html = await _fetch(client, OFFICES_URL)
            if not index_html:
                result["status"] = "blocked"
                result["errors"].append("Kunde inte hämta kontorsindex (möjlig bot-blockering eller sajten är nere).")
                result["finished_at"] = datetime.now(timezone.utc).isoformat()
                return result

            offices = _parse_offices_index(index_html)
            result["offices_found"] = len(offices)
            if not offices:
                result["status"] = "no_data"
                result["errors"].append("Inga kontor hittades på indexsidan — strukturen kan ha ändrats.")
                result["finished_at"] = datetime.now(timezone.utc).isoformat()
                return result

            sem = asyncio.Semaphore(3)

            async def parse_one(o):
                async with sem:
                    html = await _fetch(client, o["url"])
                    if not html:
                        return None
                    return _parse_office_page(o["url"], html)

            tasks = [parse_one(o) for o in offices[:limit]]
            parsed = await asyncio.gather(*tasks)
            parsed = [p for p in parsed if p]
            result["offices_parsed"] = len(parsed)
            result["offices"] = parsed
    except Exception as e:
        logger.exception("Scrape error")
        result["status"] = "error"
        result["errors"].append(str(e))

    result["finished_at"] = datetime.now(timezone.utc).isoformat()
    return result
