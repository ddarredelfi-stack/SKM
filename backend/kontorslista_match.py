"""Matching between kontorslista office names and scraped office names.

The first sync attempt matched on `city`, which failed badly: skandiamaklarna.se
reports the postal town of the serving office (Lund's page says city "Malmö"),
so Malmö's performance data spread to Lomma/Lund/Staffanstorp and offices whose
postal town didn't equal their market name lost their data entirely.

This module matches on the office NAME instead, in three passes:
  1. Exact normalized name match ("Enskede/Trångsund" == "Enskede/Trångsund")
  2. Explicit alias map for known renames ("Hisingen" -> "Göteborg Hisingen")
  3. Segment intersection: names are split on "/" and two names match if they
     share a segment ("Älvsjö/Årsta" ~ "Älvsjö/Bandhagen/Fruängen" via "älvsjö").
     When several candidates share a segment, the one matching the FIRST
     segment of the kontorslista name wins; remaining ambiguity = no match
     (better to drop data than to guess wrong).

Each scraped office can receive at most one kontorslista record.
"""
from __future__ import annotations

PERF_FIELDS = [
    "kategori", "prio", "prio_num", "oms", "oms_fjol", "sald",
    "sald_fjol", "yoy_pct", "kommentar", "recommended_action", "region",
]

# kontorslista name (normalized) -> scraped name (normalized)
ALIASES = {
    "hisingen": "göteborg hisingen",
    "stockholms skärgård": "stockholm skärgård",
    "spånga": "spånga/beckomberga/bällsta/eneby/mariehäll",
    "hägersten": "hägersten/liljeholmen/skärholmen",
    "strängnäs": "strängnäs/mariefred",
}


def norm_name(s: str | None) -> str:
    s = (s or "").strip().lower()
    for prefix in ("skandiamäklarna ", "skandiamaklarna "):
        if s.startswith(prefix):
            s = s[len(prefix):]
    return " ".join(s.split())


def _segments(name: str) -> list[str]:
    return [seg.strip() for seg in name.split("/") if seg.strip()]


def match_offices(kontorslista_names: list[str], scraped_names: list[str]) -> dict[str, str]:
    """Return {kontorslista_name_norm: scraped_name_norm} for all confident matches."""
    kl = [norm_name(n) for n in kontorslista_names]
    sc = [norm_name(n) for n in scraped_names]
    sc_set = set(sc)
    assigned_scraped: set[str] = set()
    result: dict[str, str] = {}

    # Pass 1: exact
    for k in kl:
        if k in sc_set and k not in assigned_scraped:
            result[k] = k
            assigned_scraped.add(k)

    # Pass 2: aliases
    for k in kl:
        if k in result:
            continue
        alias = ALIASES.get(k)
        if alias and alias in sc_set and alias not in assigned_scraped:
            result[k] = alias
            assigned_scraped.add(alias)

    # Pass 3: segment intersection among unassigned
    for k in kl:
        if k in result:
            continue
        k_segs = _segments(k)
        if not k_segs:
            continue
        candidates = []
        for s in sc:
            if s in assigned_scraped:
                continue
            s_segs = set(_segments(s))
            overlap = [seg for seg in k_segs if seg in s_segs]
            if overlap:
                candidates.append((s, overlap))
        if len(candidates) == 1:
            s, _ = candidates[0]
            result[k] = s
            assigned_scraped.add(s)
        elif len(candidates) > 1:
            # prefer candidate containing the FIRST segment of the kontorslista name
            first = k_segs[0]
            preferred = [s for s, ov in candidates if first in ov]
            if len(preferred) == 1:
                result[k] = preferred[0]
                assigned_scraped.add(preferred[0])
            # still ambiguous -> skip (no guessing)

    return result
