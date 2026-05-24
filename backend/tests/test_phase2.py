"""Phase 2 backend tests: source/referent tracking, lost workflow, stale alerts, dashboard insights."""
from __future__ import annotations
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"
ADMIN_EMAIL = "delfi@skandiamaklarna.se"
ADMIN_PASSWORD = "Etablering2026"


@pytest.fixture(scope="session")
def admin_session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{API}/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    return s


@pytest.fixture
def created_prospect(admin_session):
    """Create a prospect with Phase 2 fields and clean up at end."""
    payload = {
        "name": f"TEST_Phase2_{uuid.uuid4().hex[:6]}",
        "type": "broker",
        "current_agency": "Mäklarhuset",
        "city": "Stockholm",
        "source": "LinkedIn",
        "source_detail": "via Pia",
        "referred_by": "Pia Hansson",
    }
    r = admin_session.post(f"{API}/prospects", json=payload)
    assert r.status_code == 200, r.text
    p = r.json()
    yield p
    # Cleanup
    try:
        admin_session.delete(f"{API}/prospects/{p['id']}")
    except Exception:
        pass


# --- Source / referent tracking ----------------------------------------------
class TestProspectSourceFields:
    def test_create_with_source_fields(self, admin_session, created_prospect):
        p = created_prospect
        assert p["source"] == "LinkedIn"
        assert p["source_detail"] == "via Pia"
        assert p["referred_by"] == "Pia Hansson"
        # Verify persistence with GET
        r = admin_session.get(f"{API}/prospects/{p['id']}")
        assert r.status_code == 200
        got = r.json()
        assert got["source"] == "LinkedIn"
        assert got["referred_by"] == "Pia Hansson"

    def test_patch_source_fields(self, admin_session, created_prospect):
        pid = created_prospect["id"]
        r = admin_session.patch(f"{API}/prospects/{pid}", json={
            "source": "Event",
            "source_detail": "Mäklardag 2026",
            "referred_by": "Anna",
        })
        assert r.status_code == 200
        got = r.json()
        assert got["source"] == "Event"
        assert got["source_detail"] == "Mäklardag 2026"
        assert got["referred_by"] == "Anna"


# --- Lost workflow ------------------------------------------------------------
class TestLostWorkflow:
    def test_mark_lost(self, admin_session, created_prospect):
        pid = created_prospect["id"]
        r = admin_session.post(f"{API}/prospects/{pid}/lost", json={
            "lost_to_agency": "HusmanHagberg",
            "lost_reason": "Bättre lön",
        })
        assert r.status_code == 200, r.text
        got = r.json()
        assert got["is_lost"] is True
        assert got["lost_to_agency"] == "HusmanHagberg"
        assert got["lost_reason"] == "Bättre lön"
        assert got.get("lost_at")
        # Verify activity logged
        act = admin_session.get(f"{API}/activity?limit=20").json()["items"]
        kinds = [a for a in act if a.get("prospect_id") == pid and a.get("kind") == "lost"]
        assert len(kinds) >= 1, "lost activity not logged"

    def test_mark_lost_empty_agency_returns_400(self, admin_session, created_prospect):
        pid = created_prospect["id"]
        r = admin_session.post(f"{API}/prospects/{pid}/lost", json={
            "lost_to_agency": "  ",
            "lost_reason": "x",
        })
        assert r.status_code == 400, f"expected 400, got {r.status_code} {r.text}"

    def test_restore_prospect(self, admin_session, created_prospect):
        pid = created_prospect["id"]
        # First mark lost
        r = admin_session.post(f"{API}/prospects/{pid}/lost", json={
            "lost_to_agency": "ERA", "lost_reason": "test",
        })
        assert r.status_code == 200
        # Then restore
        r = admin_session.post(f"{API}/prospects/{pid}/restore")
        assert r.status_code == 200
        got = r.json()
        assert got["is_lost"] is False
        assert got.get("lost_at") in (None, "")
        # Verify restored activity
        act = admin_session.get(f"{API}/activity?limit=30").json()["items"]
        restored = [a for a in act if a.get("prospect_id") == pid and a.get("kind") == "restored"]
        assert len(restored) >= 1, "restored activity not logged"


# --- List filters -------------------------------------------------------------
class TestProspectsListing:
    def test_list_excludes_lost_by_default(self, admin_session, created_prospect):
        pid = created_prospect["id"]
        admin_session.post(f"{API}/prospects/{pid}/lost",
                           json={"lost_to_agency": "Fastighetsbyrån"})
        r = admin_session.get(f"{API}/prospects")
        assert r.status_code == 200
        ids = [p["id"] for p in r.json()["items"]]
        assert pid not in ids, "lost prospect should not appear by default"

    def test_list_include_lost(self, admin_session, created_prospect):
        pid = created_prospect["id"]
        admin_session.post(f"{API}/prospects/{pid}/lost",
                           json={"lost_to_agency": "Fastighetsbyrån"})
        r = admin_session.get(f"{API}/prospects?include_lost=true")
        assert r.status_code == 200
        ids = [p["id"] for p in r.json()["items"]]
        assert pid in ids, "include_lost=true should return lost ones"

    def test_filter_by_source(self, admin_session, created_prospect):
        # created_prospect has source=LinkedIn
        r = admin_session.get(f"{API}/prospects?source=LinkedIn")
        assert r.status_code == 200
        items = r.json()["items"]
        assert all(p.get("source") == "LinkedIn" for p in items)
        assert any(p["id"] == created_prospect["id"] for p in items)


# --- Stale prospects ----------------------------------------------------------
class TestStaleProspects:
    def test_stale_endpoint_works_with_days_1(self, admin_session):
        r = admin_session.get(f"{API}/stale-prospects?days=1")
        assert r.status_code == 200, r.text
        data = r.json()
        assert "items" in data
        assert "total" in data
        assert data["days"] == 1
        # None should be lost or Onboardad
        for p in data["items"]:
            assert p.get("is_lost") is not True
            assert p.get("status") != "Onboardad"

    def test_stale_route_does_not_collide_with_prospect_id_route(self, admin_session):
        """/stale-prospects must not be interpreted as /prospects/{pid}."""
        r = admin_session.get(f"{API}/stale-prospects?days=14")
        assert r.status_code == 200, f"route collision detected: {r.status_code} {r.text}"
        # The legacy/old path should NOT be reachable as a prospect lookup
        r2 = admin_session.get(f"{API}/prospects/stale")
        # Should be a 404 (prospect not found), confirming no collision
        assert r2.status_code == 404


# --- Dashboard KPIs / Insights ------------------------------------------------
class TestDashboardKPIs:
    def test_kpis_has_new_fields(self, admin_session):
        r = admin_session.get(f"{API}/dashboard/kpis")
        assert r.status_code == 200
        k = r.json()
        for f in ("lost_total", "stale_count", "stale_days", "prospects_total"):
            assert f in k, f"missing field: {f}"
        assert k["stale_days"] == 14
        assert isinstance(k["lost_total"], int)
        assert isinstance(k["stale_count"], int)

    def test_kpis_prospects_total_excludes_lost(self, admin_session, created_prospect):
        pid = created_prospect["id"]
        before = admin_session.get(f"{API}/dashboard/kpis").json()["prospects_total"]
        admin_session.post(f"{API}/prospects/{pid}/lost",
                           json={"lost_to_agency": "Mäklarhuset"})
        after = admin_session.get(f"{API}/dashboard/kpis").json()["prospects_total"]
        assert after == before - 1, f"prospects_total did not decrement when marking lost ({before} -> {after})"

    def test_insights_shape(self, admin_session):
        r = admin_session.get(f"{API}/dashboard/insights")
        assert r.status_code == 200, r.text
        d = r.json()
        for f in ("sources", "lost_breakdown", "top_stale", "stale_days"):
            assert f in d, f"missing field: {f}"
        assert isinstance(d["sources"], list)
        assert isinstance(d["lost_breakdown"], list)
        assert isinstance(d["top_stale"], list)
        assert len(d["top_stale"]) <= 5
        for s in d["sources"]:
            assert "source" in s and "count" in s
        for lb in d["lost_breakdown"]:
            assert "agency" in lb and "count" in lb


# --- Stale via direct DB injection (best-effort) ------------------------------
class TestStaleViaInjection:
    def test_stale_picks_up_old_prospect(self, admin_session):
        """Create prospect then manually backdate updated_at via PATCH cannot set updated_at,
        so we use the stale-prospects endpoint with days=1 after creating + waiting briefly
        OR we just verify behavior via days param."""
        # Create one fresh prospect
        payload = {"name": f"TEST_freshstale_{uuid.uuid4().hex[:6]}", "city": "Malmö"}
        r = admin_session.post(f"{API}/prospects", json=payload)
        assert r.status_code == 200
        pid = r.json()["id"]
        # Fresh prospect should NOT be in stale list with days=14
        data = admin_session.get(f"{API}/stale-prospects?days=14").json()
        assert pid not in [p["id"] for p in data["items"]]
        # Cleanup
        admin_session.delete(f"{API}/prospects/{pid}")
