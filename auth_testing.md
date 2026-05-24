# Auth Testing Playbook — Skandia Etablering

## Backend testing
1. Verify MongoDB indexes exist:
   - `users.email` (unique)
   - `login_attempts.id`

2. Confirm admin user seeded with bcrypt hash starting `$2b$`:
   ```
   mongosh test_database
   db.users.findOne({email: "delfi@skandiamaklarna.se"})
   ```

3. Test endpoints (see /app/memory/test_credentials.md for creds).

## Common pitfalls
- httpOnly cookies require `samesite=none; secure=true` for cross-origin requests.
  Browser MUST be on https for the cookie to be accepted.
- React axios MUST use `withCredentials: true` on every request.
- CORS must use explicit origin (not `*`) when allow_credentials=True.
- 401 from /api/auth/me on first load is EXPECTED if no session — UI should
  treat as "not logged in" and route to /login.

## Frontend testing checklist
- [ ] Unauthenticated user lands on /login
- [ ] After login, redirected to dashboard
- [ ] Refresh page keeps session (cookie persists)
- [ ] Logout clears session and routes back to /login
- [ ] Sidebar shows logged-in user's name + role
- [ ] /team (admin route) blocks members with 403 UI message
- [ ] New prospect auto-assigns to current user as owner
- [ ] "Mina prospekt" toggle filters to owner_id=me
- [ ] Activity log shows actor name on every entry
