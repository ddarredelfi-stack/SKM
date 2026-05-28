"""Tests for explicit office-coupling feature on prospects.

Covers:
- POST /api/prospects with office_id sets office_name automatically
- PATCH /api/prospects/{id} with office_id updates both fields; empty string clears
- GET /api/offices/{id} returns prospects linked via office_id AND legacy city-matched (no dups)
- GET /api/dashboard/office-recruitment counts explicit office-linked prospects correctly
- POST /api/offices/{id}/link-city-prospects bulk-links city-matched prospects
- Activity log writes 'office_linked' entry on office_id change
- Regression: create/update without office_id still works
"""
from __future__ import annotations
import os
import pytest
import requests

BASE = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE}/api"
ADMIN_EMAIL = "delfi@skandiamaklarna.se"
ADMIN_PASS = "Etablering2026"


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASS})
    if r.status_code != 200:
        pytest.skip(f"Login failed: {r.status_code} {r.text}")
    return s


@pytest.fixture(scope="module")
def two_offices(client):
    r = client.get(f"{API}/offices")
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) >= 2, "Need at least 2 seeded offices"
    return items[0], items[1]


@pytest.fixture
def cleanup(client):
    created = []
    yield created
    for pid in created:
        client.delete(f"{API}/prospects/{pid}")


class TestCreateWithOffice:
    def test_create_with_office_id_sets_name(self, client, two_offices, cleanup):
        o1, _ = two_offices
        payload = {
            "name": "TEST_OfficeCoupling Create",
            "type": "broker",
            "current_agency": "Fastighetsbyrån",
            "city": "Annan Stad",
            "status": "Identifierad",
            "office_id": o1["id"],
        }
        r = client.post(f"{API}/prospects", json=payload)
        assert r.status_code == 200, r.text
        d = r.json()
        cleanup.append(d["id"])
        assert d["office_id"] == o1["id"]
        assert d["office_name"] == o1["name"]
        # Verify persistence
        r = client.get(f"{API}/prospects/{d['id']}")
        assert r.status_code == 200
        assert r.json()["office_name"] == o1["name"]

    def test_create_without_office_id_regression(self, client, cleanup):
        payload = {
            "name": "TEST_NoOffice",
            "type": "broker",
            "current_agency": "Bjurfors",
            "city": "Lund",
            "status": "Identifierad",
        }
        r = client.post(f"{API}/prospects", json=payload)
        assert r.status_code == 200, r.text
        d = r.json()
        cleanup.append(d["id"])
        assert d.get("office_id") in (None, "")
        assert d.get("office_name", "") == ""


class TestPatchOffice:
    def test_patch_sets_and_clears_office(self, client, two_offices, cleanup):
        o1, o2 = two_offices
        # Start without office
        r = client.post(f"{API}/prospects", json={
            "name": "TEST_PatchOffice",
            "type": "broker", "current_agency": "X", "city": "Y",
            "status": "Identifierad",
        })
        assert r.status_code == 200
        pid = r.json()["id"]
        cleanup.append(pid)

        # PATCH set office_id → o1
        r = client.patch(f"{API}/prospects/{pid}", json={"office_id": o1["id"]})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["office_id"] == o1["id"]
        assert d["office_name"] == o1["name"]

        # PATCH change to o2
        r = client.patch(f"{API}/prospects/{pid}", json={"office_id": o2["id"]})
        assert r.status_code == 200
        assert r.json()["office_name"] == o2["name"]

        # PATCH clear with empty string
        r = client.patch(f"{API}/prospects/{pid}", json={"office_id": ""})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("office_id") in (None, "")
        assert d.get("office_name", "") == ""

        # Verify GET shows cleared
        r = client.get(f"{API}/prospects/{pid}")
        assert r.json().get("office_name", "") == ""

    def test_activity_office_linked_entry(self, client, two_offices, cleanup):
        o1, _ = two_offices
        r = client.post(f"{API}/prospects", json={
            "name": "TEST_ActivityOfficeLink",
            "type": "broker", "current_agency": "X", "city": "Z",
            "status": "Identifierad",
        })
        pid = r.json()["id"]
        cleanup.append(pid)

        r = client.patch(f"{API}/prospects/{pid}", json={"office_id": o1["id"]})
        assert r.status_code == 200

        r = client.get(f"{API}/activity", params={"limit": 50})
        items = r.json()["items"]
        msgs = [(a.get("kind"), a.get("message", "")) for a in items]
        # Look for office_linked entry referencing prospect name
        found = any(t == "office_linked" and "TEST_ActivityOfficeLink" in m for t, m in msgs)
        assert found, f"office_linked activity entry missing. Got: {msgs[:8]}"


class TestOfficeDetailListsProspects:
    def test_get_office_includes_explicit_and_city_prospects(self, client, two_offices, cleanup):
        o1, _ = two_offices
        city = o1.get("city") or "Stockholm"

        # Prospect 1: explicit office_id, different city
        r1 = client.post(f"{API}/prospects", json={
            "name": "TEST_ExplicitOffice",
            "type": "broker", "current_agency": "A",
            "city": "Annan Stad Helt",  # not matching
            "status": "Identifierad",
            "office_id": o1["id"],
        })
        cleanup.append(r1.json()["id"])

        # Prospect 2: legacy — no office_id but matching city
        r2 = client.post(f"{API}/prospects", json={
            "name": "TEST_LegacyCity",
            "type": "broker", "current_agency": "B",
            "city": city,
            "status": "Identifierad",
        })
        cleanup.append(r2.json()["id"])

        r = client.get(f"{API}/offices/{o1['id']}")
        assert r.status_code == 200
        prospects = r.json()["prospects"]
        names = [p["name"] for p in prospects]
        assert "TEST_ExplicitOffice" in names
        assert "TEST_LegacyCity" in names
        # No duplicates by id
        ids = [p["id"] for p in prospects]
        assert len(ids) == len(set(ids))


class TestOfficeRecruitmentDashboard:
    def test_explicit_office_counted(self, client, two_offices, cleanup):
        o1, _ = two_offices

        # Get baseline counts
        r = client.get(f"{API}/dashboard/office-recruitment")
        assert r.status_code == 200
        rows = r.json()["rows"]
        baseline_row = next(x for x in rows if x["office_id"] == o1["id"])
        base_pipeline = baseline_row["in_pipeline"]
        base_signed = baseline_row["current_hires"]

        # Add a Signerad prospect via explicit office_id (different city)
        r = client.post(f"{API}/prospects", json={
            "name": "TEST_Recruit_Signed",
            "type": "broker", "current_agency": "X",
            "city": "Unrelated City",
            "status": "Signerad",
            "office_id": o1["id"],
        })
        cleanup.append(r.json()["id"])

        # Add an active prospect via explicit office
        r = client.post(f"{API}/prospects", json={
            "name": "TEST_Recruit_Active",
            "type": "broker", "current_agency": "X",
            "city": "Unrelated City",
            "status": "Kontaktad",
            "office_id": o1["id"],
        })
        cleanup.append(r.json()["id"])

        r = client.get(f"{API}/dashboard/office-recruitment")
        rows = r.json()["rows"]
        row = next(x for x in rows if x["office_id"] == o1["id"])
        assert row["current_hires"] == base_signed + 1, "Signerad explicit-office prospect not counted"
        assert row["in_pipeline"] >= base_pipeline + 2, \
            "Active explicit-office prospects not in pipeline count"


class TestLinkCityProspects:
    def test_bulk_link_assigns_legacy_prospects(self, client, two_offices, cleanup):
        o1, _ = two_offices
        city = o1.get("city")
        if not city:
            pytest.skip("Office has no city")

        # Create a legacy prospect without office_id
        r = client.post(f"{API}/prospects", json={
            "name": "TEST_BulkLink",
            "type": "broker", "current_agency": "X",
            "city": city,
            "status": "Identifierad",
        })
        pid = r.json()["id"]
        cleanup.append(pid)
        assert r.json().get("office_id") in (None, "")

        # Run bulk link
        r = client.post(f"{API}/offices/{o1['id']}/link-city-prospects", json={})
        assert r.status_code == 200, r.text
        assert r.json()["linked"] >= 1

        # Verify the prospect now has explicit office_id
        r = client.get(f"{API}/prospects/{pid}")
        assert r.json()["office_id"] == o1["id"]
        assert r.json()["office_name"] == o1["name"]
