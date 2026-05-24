"""End-to-end backend tests for Skandiamäklarna Etablering Dashboard.

Tests all critical routes via the external public URL (REACT_APP_BACKEND_URL).
"""
from __future__ import annotations
import os
import time

import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://recruiter-dash-10.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

PIPELINE_STATUSES = [
    "Identifierad", "Kontaktad", "Möte bokat",
    "Förhandling", "Signerad", "Onboardad",
]


@pytest.fixture(scope="session")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# --- Health / Dashboard --------------------------------------------------
class TestHealth:
    def test_root(self, session):
        r = session.get(f"{API}/")
        assert r.status_code == 200
        assert r.json().get("ok") is True

    def test_dashboard_kpis(self, session):
        r = session.get(f"{API}/dashboard/kpis")
        assert r.status_code == 200
        d = r.json()
        for k in ["offices", "brokers", "listings", "prospects_total",
                  "pipeline", "regions_covered", "goals", "activity"]:
            assert k in d, f"Missing {k}"
        assert d["offices"] > 0
        assert d["brokers"] > 0
        assert d["listings"] > 0
        assert set(PIPELINE_STATUSES).issubset(d["pipeline"].keys())
        assert isinstance(d["goals"], list)
        assert isinstance(d["activity"], list)


# --- Read-only collections ----------------------------------------------
class TestReadOnly:
    def test_offices(self, session):
        r = session.get(f"{API}/offices")
        assert r.status_code == 200
        items = r.json()["items"]
        assert len(items) >= 1
        assert "name" in items[0]

    def test_offices_search(self, session):
        r = session.get(f"{API}/offices", params={"q": "Stockholm"})
        assert r.status_code == 200
        # Should at least return without error
        assert "items" in r.json()

    def test_brokers(self, session):
        r = session.get(f"{API}/brokers")
        assert r.status_code == 200
        items = r.json()["items"]
        assert len(items) > 0

    def test_brokers_search(self, session):
        r = session.get(f"{API}/brokers", params={"q": "a"})
        assert r.status_code == 200
        assert "items" in r.json()

    def test_listings(self, session):
        r = session.get(f"{API}/listings")
        assert r.status_code == 200
        assert "items" in r.json()


# --- Prospects CRUD ------------------------------------------------------
class TestProspects:
    def test_list(self, session):
        r = session.get(f"{API}/prospects")
        assert r.status_code == 200
        d = r.json()
        assert "items" in d and "grouped" in d and "statuses" in d
        assert d["statuses"] == PIPELINE_STATUSES
        # Seeded: one prospect per status
        for s in PIPELINE_STATUSES:
            assert s in d["grouped"]

    def test_create_update_status_delete(self, session):
        # CREATE
        payload = {
            "name": "TEST_Anna Andersson",
            "type": "broker",
            "current_agency": "Fastighetsbyrån",
            "city": "Uppsala",
            "region": "Uppland",
            "email": "test_anna@example.com",
            "status": "Identifierad",
            "notes": "Test prospect",
        }
        r = session.post(f"{API}/prospects", json=payload)
        assert r.status_code == 200, r.text
        created = r.json()
        assert created["name"] == payload["name"]
        assert created["status"] == "Identifierad"
        pid = created["id"]

        # GET
        r = session.get(f"{API}/prospects/{pid}")
        assert r.status_code == 200
        assert r.json()["name"] == payload["name"]

        # PATCH fields
        r = session.patch(f"{API}/prospects/{pid}", json={"notes": "Updated notes"})
        assert r.status_code == 200
        assert r.json()["notes"] == "Updated notes"

        # PATCH status
        r = session.patch(f"{API}/prospects/{pid}/status", json={"status": "Kontaktad"})
        assert r.status_code == 200
        assert r.json()["status"] == "Kontaktad"

        # Verify activity log has the status change
        r = session.get(f"{API}/activity", params={"limit": 50})
        assert r.status_code == 200
        msgs = [a["message"] for a in r.json()["items"]]
        assert any("Kontaktad" in m for m in msgs)

        # Invalid status
        r = session.patch(f"{API}/prospects/{pid}/status", json={"status": "Bogus"})
        assert r.status_code == 400

        # DELETE
        r = session.delete(f"{API}/prospects/{pid}")
        assert r.status_code == 200
        assert r.json()["ok"] is True

        # Verify gone
        r = session.get(f"{API}/prospects/{pid}")
        assert r.status_code == 404


# --- Activity ------------------------------------------------------------
class TestActivity:
    def test_feed(self, session):
        r = session.get(f"{API}/activity")
        assert r.status_code == 200
        items = r.json()["items"]
        assert isinstance(items, list)
        if len(items) >= 2:
            # Sorted desc by created_at
            assert items[0]["created_at"] >= items[1]["created_at"]


# --- Goals CRUD ----------------------------------------------------------
class TestGoals:
    def test_crud(self, session):
        # Create
        r = session.post(f"{API}/goals",
                         json={"title": "TEST_Goal", "target": 10, "current": 1, "metric": "st"})
        assert r.status_code == 200
        g = r.json()
        gid = g["id"]
        assert g["target"] == 10

        # List contains it
        r = session.get(f"{API}/goals")
        assert r.status_code == 200
        assert any(x["id"] == gid for x in r.json()["items"])

        # Patch
        r = session.patch(f"{API}/goals/{gid}", json={"current": 5})
        assert r.status_code == 200
        assert r.json()["current"] == 5

        # Delete
        r = session.delete(f"{API}/goals/{gid}")
        assert r.status_code == 200
        # 404 next time
        r = session.delete(f"{API}/goals/{gid}")
        assert r.status_code == 404


# --- Geo -----------------------------------------------------------------
class TestGeo:
    def test_municipalities(self, session):
        r = session.get(f"{API}/geo/municipalities")
        assert r.status_code == 200
        d = r.json()
        assert d["total"] > 0
        sample = d["items"][0]
        for k in ["name", "lat", "lng", "population", "has_skandia", "competitors"]:
            assert k in sample

    def test_whitespots(self, session):
        r = session.get(f"{API}/geo/whitespots")
        assert r.status_code == 200
        items = r.json()["items"]
        assert isinstance(items, list)
        for m in items:
            assert m["has_skandia"] is False
            assert "opportunity_score" in m
        # Sorted desc by opportunity_score
        if len(items) >= 2:
            assert items[0]["opportunity_score"] >= items[-1]["opportunity_score"]


# --- Scrape --------------------------------------------------------------
class TestScrape:
    def test_status_initial(self, session):
        r = session.get(f"{API}/scrape/status")
        assert r.status_code == 200

    def test_run(self, session):
        r = session.post(f"{API}/scrape/run", params={"limit": 2}, timeout=120)
        # Any status is OK (may be blocked, ok, no_data); only an error/throw is a bug
        assert r.status_code == 200, r.text
        d = r.json()
        assert "status" in d
        assert d["status"] in ("ok", "blocked", "no_data", "error", "partial")

    def test_status_after(self, session):
        r = session.get(f"{API}/scrape/status")
        assert r.status_code == 200
        last = r.json().get("last")
        # After running, should not be None
        assert last is not None


# --- AI brief ------------------------------------------------------------
class TestAI:
    def test_brief(self, session):
        # Use a real seeded prospect
        r = session.get(f"{API}/prospects")
        pid = r.json()["items"][0]["id"]
        name = r.json()["items"][0]["name"]
        city = r.json()["items"][0].get("city", "")

        r = session.post(f"{API}/ai/research-brief",
                         json={"prospect_id": pid, "name": name, "city": city,
                               "current_agency": "Fastighetsbyrån"},
                         timeout=120)
        assert r.status_code == 200, r.text
        brief = r.json()["brief"]
        assert isinstance(brief, str)
        assert len(brief) > 100, "Brief too short"
        # Strict markdown format expected sections
        assert "Sammanfattning" in brief or "###" in brief


# --- Reminders -----------------------------------------------------------
class TestReminders:
    def test_send_skipped(self, session):
        r = session.get(f"{API}/prospects")
        pid = r.json()["items"][0]["id"]
        # No recipient set, RESEND_API_KEY empty -> should be skipped gracefully
        r = session.post(f"{API}/reminders/send", json={"prospect_id": pid})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("status") in ("skipped", "success")

    def test_due(self, session):
        r = session.get(f"{API}/reminders/due", params={"days_ahead": 7})
        assert r.status_code == 200
        assert "items" in r.json()


# --- CSV exports ---------------------------------------------------------
class TestCsv:
    @pytest.mark.parametrize("path", ["offices.csv", "brokers.csv", "prospects.csv"])
    def test_csv(self, session, path):
        r = session.get(f"{API}/export/{path}")
        assert r.status_code == 200
        assert "text/csv" in r.headers.get("content-type", "")
        # Has at least a header line
        first_line = r.text.splitlines()[0]
        assert "," in first_line
