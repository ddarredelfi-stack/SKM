"""Rollkategorisering av medarbetare utifrån titel.

Titlarna kommer från skandiamaklarna.se och är ofta kombinationer
("Fastighetsmäklare / Partner", "Fastighetsmäklare / Kontorschef",
"Fastighetsmäklare / Certifierad Nyproduktion / Franchisetagare").

Kategoriseringen sker i prioritetsordning — ägar-/ledarroller vinner över
mäklarrollen eftersom det är den distinktionen som spelar roll för
etablerings-/rekryteringsarbetet. Ursprungstiteln visas alltid i UI:t,
så ingen information går förlorad.
"""
from __future__ import annotations

ROLE_CATEGORIES = [
    "Partner/Franchisetagare",
    "Kontorschef",
    "Koordinator",
    "Assistent",
    "Fastighetsmäklare",
    "Övrig roll",
]

# (kategori, nyckelord i lowercase-titel) — första träff vinner
_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("Partner/Franchisetagare", ("partner", "franchis", "delägare", "ägare", "vd")),
    ("Kontorschef", ("kontorschef", "chef", "ledare")),
    ("Koordinator", ("koordinator", "koord")),
    ("Assistent", ("assistent",)),
    ("Fastighetsmäklare", ("mäklare", "maklare", "certifierad", "nyproduktion")),
]


def categorize_title(title: str | None) -> str:
    low = (title or "").lower()
    if not low.strip():
        return "Övrig roll"
    for category, keywords in _RULES:
        if any(kw in low for kw in keywords):
            return category
    return "Övrig roll"
