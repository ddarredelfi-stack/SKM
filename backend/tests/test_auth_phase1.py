"""Phase 1 auth + multi-user backend tests.

Covers: login (success/fail/lockout), cookies, /auth/me, /auth/refresh, /auth/logout,
Bearer fallback, protected endpoints, users CRUD (admin vs member),
prospects owner_id assignment and filters, activity actor logging, CORS.
"""
from __future__ import annotations
import os
import uuid
import time

import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"
ADMIN_EMAIL = "delfi@skandiamaklarna.se"
ADMIN_PASSWORD = "Etablering2026"
FRONTEND_URL = os.environ.get("FRONTEND_URL", BASE_URL)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def admin_session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{API}/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    data = r.json()
    assert "access_token" in data
    assert "user" in data
    assert data["user"]["role"] == "admin"
    assert "password_hash" not in data["user"]
    # Cookies should be set
    assert "access_token" in s.cookies
    assert "refresh_token" in s.cookies
    s.admin_id = data["user"]["id"]
    s.admin_token = data["access_token"]
    return s


@pytest.fixture(scope="session")
def member_session(admin_session):
    """Create a TEST_ member user (or reuse) and return a logged-in session."""
    email = f"test_member_{uuid.uuid4().hex[:6]}@example.com"
    password = "MemberPass123!"
    r = admin_session.post(f"{API}/users", json={
        "email": email, "password": password,
        "name": "TEST_Member", "role": "member",
    })
    assert r.status_code == 200, r.text
    member_id = r.json()["id"]

    ms = requests.Session()
    ms.headers.update({"Content-Type": "application/json"})
    r = ms.post(f"{API}/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    ms.member_id = member_id
    ms.member_email = email
    return ms


# ---------------------------------------------------------------------------
# 1. Auth core
# ---------------------------------------------------------------------------
class TestAuth:
    def test_login_success_sets_cookies(self):
        s = requests.Session()
        r = s.post(f"{API}/auth/login",
                   json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        assert r.status_code == 200
        data = r.json()
        assert data["user"]["email"] == ADMIN_EMAIL
        assert data["user"]["role"] == "admin"
        assert "password_hash" not in data["user"]
        assert isinstance(data["access_token"], str) and len(data["access_token"]) > 20
        # Cookies
        assert "access_token" in s.cookies
        assert "refresh_token" in s.cookies
        # Set-Cookie headers should mark HttpOnly
        sc = r.headers.get("set-cookie", "")
        assert "HttpOnly" in sc or "httponly" in sc.lower()

    def test_login_wrong_password_401(self):
        # Use unique email to not affect brute force counter for admin
        r = requests.post(f"{API}/auth/login",
                          json={"email": ADMIN_EMAIL, "password": "WRONG_pw_xyz"})
        assert r.status_code == 401
        assert "Fel" in r.json().get("detail", "")

    def test_me_with_cookie(self, admin_session):
        r = admin_session.get(f"{API}/auth/me")
        assert r.status_code == 200
        u = r.json()
        assert u["email"] == ADMIN_EMAIL
        assert "password_hash" not in u

    def test_me_without_auth_401(self):
        r = requests.get(f"{API}/auth/me")
        assert r.status_code == 401

    def test_bearer_fallback(self, admin_session):
        # New session with no cookies, just Authorization header
        s = requests.Session()
        s.headers.update({
            "Authorization": f"Bearer {admin_session.admin_token}",
            "Content-Type": "application/json",
        })
        r = s.get(f"{API}/auth/me")
        assert r.status_code == 200, r.text
        assert r.json()["email"] == ADMIN_EMAIL

    def test_refresh_with_cookie(self, admin_session):
        # Use a fresh session: login then refresh
        s = requests.Session()
        s.post(f"{API}/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        r = s.post(f"{API}/auth/refresh")
        assert r.status_code == 200, r.text
        data = r.json()
        assert "access_token" in data
        assert "user" in data

    def test_refresh_no_cookie_401(self):
        r = requests.post(f"{API}/auth/refresh")
        assert r.status_code == 401

    def test_logout_clears_cookies(self):
        s = requests.Session()
        s.post(f"{API}/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        assert "access_token" in s.cookies
        r = s.post(f"{API}/auth/logout")
        assert r.status_code == 200
        # Server's delete_cookie sends Set-Cookie with Max-Age=0 / empty value
        sc = r.headers.get("set-cookie", "").lower()
        assert "access_token=" in sc
        # After logout, /auth/me should fail (cookie cleared in jar)
        r2 = s.get(f"{API}/auth/me")
        assert r2.status_code == 401

    def test_brute_force_lockout(self):
        """5 failed attempts on a unique email returns 429."""
        unique_email = f"lockout_{uuid.uuid4().hex[:8]}@example.com"
        last_status = None
        for i in range(6):
            r = requests.post(f"{API}/auth/login",
                              json={"email": unique_email, "password": "wrong"})
            last_status = r.status_code
            if last_status == 429:
                break
        assert last_status == 429, f"Expected 429 lockout, got {last_status}"


# ---------------------------------------------------------------------------
# 2. CORS
# ---------------------------------------------------------------------------
class TestCors:
    def test_cors_credentials(self):
        r = requests.options(
            f"{API}/auth/login",
            headers={
                "Origin": FRONTEND_URL,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type",
            },
        )
        # Preflight should allow
        assert r.status_code in (200, 204), r.status_code
        acao = r.headers.get("access-control-allow-origin", "")
        acac = r.headers.get("access-control-allow-credentials", "")
        assert acao == FRONTEND_URL, f"Expected explicit origin, got '{acao}'"
        assert acac.lower() == "true"


# ---------------------------------------------------------------------------
# 3. Protected endpoints
# ---------------------------------------------------------------------------
class TestProtected:
    @pytest.mark.parametrize("path", [
        "/dashboard/kpis", "/offices", "/brokers", "/prospects",
        "/users", "/activity", "/goals",
    ])
    def test_requires_auth(self, path):
        r = requests.get(f"{API}{path}")
        assert r.status_code == 401, f"{path} should be 401 without auth, got {r.status_code}"

    @pytest.mark.parametrize("path", [
        "/dashboard/kpis", "/offices", "/brokers", "/prospects", "/users", "/activity",
    ])
    def test_works_with_auth(self, admin_session, path):
        r = admin_session.get(f"{API}{path}")
        assert r.status_code == 200, f"{path}: {r.status_code} {r.text}"


# ---------------------------------------------------------------------------
# 4. Users CRUD
# ---------------------------------------------------------------------------
class TestUsersCrud:
    def test_list_users(self, admin_session):
        r = admin_session.get(f"{API}/users")
        assert r.status_code == 200
        items = r.json()["items"]
        assert any(u["email"] == ADMIN_EMAIL for u in items)
        for u in items:
            assert "password_hash" not in u

    def test_admin_creates_user_member_cannot(self, admin_session, member_session):
        # Admin creates
        email = f"test_user_{uuid.uuid4().hex[:6]}@example.com"
        r = admin_session.post(f"{API}/users", json={
            "email": email, "password": "Pw12345!",
            "name": "TEST_NewUser", "role": "member",
        })
        assert r.status_code == 200, r.text
        new_id = r.json()["id"]
        assert r.json()["role"] == "member"

        # Verify via GET
        r2 = admin_session.get(f"{API}/users")
        assert any(u["id"] == new_id for u in r2.json()["items"])

        # Member cannot create
        r3 = member_session.post(f"{API}/users", json={
            "email": f"x_{uuid.uuid4().hex[:6]}@e.com",
            "password": "Pw12345!", "name": "X", "role": "member",
        })
        assert r3.status_code == 403

        # Cleanup
        admin_session.delete(f"{API}/users/{new_id}")

    def test_admin_patch_role_and_delete(self, admin_session):
        email = f"test_patch_{uuid.uuid4().hex[:6]}@example.com"
        r = admin_session.post(f"{API}/users", json={
            "email": email, "password": "Pw12345!",
            "name": "TEST_Patch", "role": "member",
        })
        uid = r.json()["id"]
        # Patch role -> admin
        r = admin_session.patch(f"{API}/users/{uid}", json={"role": "admin"})
        assert r.status_code == 200
        assert r.json()["role"] == "admin"
        # Verify persisted
        r = admin_session.get(f"{API}/users")
        u = next(u for u in r.json()["items"] if u["id"] == uid)
        assert u["role"] == "admin"
        # Delete
        r = admin_session.delete(f"{API}/users/{uid}")
        assert r.status_code == 200

    def test_admin_cannot_delete_self(self, admin_session):
        r = admin_session.delete(f"{API}/users/{admin_session.admin_id}")
        assert r.status_code == 400

    def test_delete_user_unassigns_prospects(self, admin_session):
        # Create a temp member
        email = f"test_owner_{uuid.uuid4().hex[:6]}@example.com"
        r = admin_session.post(f"{API}/users", json={
            "email": email, "password": "Pw12345!",
            "name": "TEST_Owner", "role": "member",
        })
        owner_id = r.json()["id"]

        # Create a prospect owned by this user
        r = admin_session.post(f"{API}/prospects", json={
            "name": "TEST_OwnedProspect", "owner_id": owner_id,
            "status": "Identifierad",
        })
        assert r.status_code == 200, r.text
        pid = r.json()["id"]
        assert r.json()["owner_id"] == owner_id

        # Delete the owner user
        r = admin_session.delete(f"{API}/users/{owner_id}")
        assert r.status_code == 200

        # Prospect should now be unassigned
        r = admin_session.get(f"{API}/prospects/{pid}")
        assert r.status_code == 200
        assert r.json().get("owner_id") in (None, "")

        # Cleanup
        admin_session.delete(f"{API}/prospects/{pid}")


# ---------------------------------------------------------------------------
# 5. Prospects owner behaviour
# ---------------------------------------------------------------------------
class TestProspectsOwner:
    def test_create_without_owner_assigns_current(self, admin_session):
        r = admin_session.post(f"{API}/prospects", json={
            "name": "TEST_AutoOwner", "status": "Identifierad",
        })
        assert r.status_code == 200
        p = r.json()
        assert p["owner_id"] == admin_session.admin_id
        assert p["owner_name"]
        admin_session.delete(f"{API}/prospects/{p['id']}")

    def test_create_with_invalid_owner_is_null(self, admin_session):
        r = admin_session.post(f"{API}/prospects", json={
            "name": "TEST_BadOwner", "status": "Identifierad",
            "owner_id": "no-such-user-id",
        })
        assert r.status_code == 200
        p = r.json()
        assert p.get("owner_id") in (None, "")
        admin_session.delete(f"{API}/prospects/{p['id']}")

    def test_patch_owner_unassign_and_reassign(self, admin_session, member_session):
        # Create owned by admin
        r = admin_session.post(f"{API}/prospects", json={
            "name": "TEST_Reassign", "status": "Identifierad",
        })
        pid = r.json()["id"]

        # PATCH owner_id="" → unassign
        r = admin_session.patch(f"{API}/prospects/{pid}", json={"owner_id": ""})
        assert r.status_code == 200
        assert r.json().get("owner_id") in (None, "")

        # PATCH owner_id=member → reassign
        r = admin_session.patch(f"{API}/prospects/{pid}",
                                json={"owner_id": member_session.member_id})
        assert r.status_code == 200
        assert r.json()["owner_id"] == member_session.member_id

        # Activity should have an 'assigned' entry
        r = admin_session.get(f"{API}/activity", params={"limit": 50})
        kinds = [a.get("kind") for a in r.json()["items"]]
        assert "assigned" in kinds

        admin_session.delete(f"{API}/prospects/{pid}")

    def test_filter_owner(self, admin_session, member_session):
        # Create one for admin and one for member
        r = admin_session.post(f"{API}/prospects", json={
            "name": "TEST_FilterAdmin", "status": "Identifierad",
        })
        p_admin = r.json()["id"]
        r = admin_session.post(f"{API}/prospects", json={
            "name": "TEST_FilterMember", "status": "Identifierad",
            "owner_id": member_session.member_id,
        })
        p_member = r.json()["id"]
        # Unassigned
        r = admin_session.post(f"{API}/prospects", json={
            "name": "TEST_FilterUnassigned", "status": "Identifierad",
            "owner_id": "no-such",
        })
        p_un = r.json()["id"]

        # ?owner=me as admin → contains admin's prospect, not member's
        r = admin_session.get(f"{API}/prospects", params={"owner": "me"})
        ids = [p["id"] for p in r.json()["items"]]
        assert p_admin in ids
        assert p_member not in ids

        # ?owner=<member uuid>
        r = admin_session.get(f"{API}/prospects",
                              params={"owner": member_session.member_id})
        ids = [p["id"] for p in r.json()["items"]]
        assert p_member in ids
        assert p_admin not in ids

        # ?owner=unassigned
        r = admin_session.get(f"{API}/prospects", params={"owner": "unassigned"})
        ids = [p["id"] for p in r.json()["items"]]
        assert p_un in ids

        # Cleanup
        for pid in (p_admin, p_member, p_un):
            admin_session.delete(f"{API}/prospects/{pid}")


# ---------------------------------------------------------------------------
# 6. Activity actor logging
# ---------------------------------------------------------------------------
class TestActivityActor:
    def test_actor_logged(self, admin_session):
        r = admin_session.post(f"{API}/prospects",
                               json={"name": "TEST_ActorLog", "status": "Identifierad"})
        pid = r.json()["id"]
        r = admin_session.get(f"{API}/activity", params={"limit": 20})
        recent = r.json()["items"][0]
        assert recent.get("actor_id") == admin_session.admin_id
        assert recent.get("actor_name")
        admin_session.delete(f"{API}/prospects/{pid}")


# ---------------------------------------------------------------------------
# 7. Cleanup TEST_ users at end of session
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session", autouse=True)
def cleanup_at_end(admin_session):
    yield
    try:
        r = admin_session.get(f"{API}/users")
        for u in r.json().get("items", []):
            if u["name"].startswith("TEST_") or u["email"].startswith("test_"):
                if u["id"] != admin_session.admin_id:
                    admin_session.delete(f"{API}/users/{u['id']}")
    except Exception:
        pass
