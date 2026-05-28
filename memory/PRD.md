# Skandiamäklarna Etableringschef-Dashboard — PRD

## Original Problem Statement (kort)
Bygg ett dagligt arbetsverktyg för en nytillsatt etableringschef på Skandiamäklarna.
Verktyget ska driva expansion (rekrytera kontor + värva enskilda mäklare) och samla
all data + pipeline + geo-analys på ett ställe. Ton: professionellt, nollfluff.
Inspiration: Notion möter HubSpot.

## User Persona
- **Delfi** — nationell etableringschef. Använder verktyget dagligen på desktop,
  ibland mobil. Ingen inloggning (single-user). Värdesätter densitet, sökbarhet,
  CSV-export och snabba snabblänkar.

## Core Requirements (statiska)
- Datakälla: skandiamaklarna.se (live scrape via knapp + seedad baseline med 30
  kontor, 212 mäklare, 547 objekt).
- Värvningspipeline (kanban): Identifierad → Kontaktad → Möte bokat → Förhandling
  → Signerad → Onboardad. Drag-and-drop. Anteckningar + nästa-steg-datum.
- Geografisk analys (Sverige-karta + tabell): kontor + white spots, opportunity
  score (befolkning × transaktioner − konkurrenter).
- Dashboard KPI:er + aktivitetslogg + mål.
- AI research-brief (Claude Sonnet 4.5 via Emergent LLM Key).
- CSV-export (kontor, mäklare, prospekt).
- E-postpåminnelser (Resend — kräver RESEND_API_KEY i .env).

## Implementation Status (2026-02 / iteration 1)
- ✅ Backend FastAPI med 24 endpoints (CRUD prospekt, KPIs, geo, scrape, AI, export, mail).
- ✅ MongoDB seedat: 30 kontor, 212 mäklare, 547 objekt, 6 prospekt, 3 mål.
- ✅ Live scraper för skandiamaklarna.se (httpx + BeautifulSoup, blockerings-säker).
- ✅ Frontend (React 19 + react-router): Dashboard, Pipeline (kanban + DnD), Offices,
  Brokers, Map (react-leaflet + CartoDB Positron), Scrape, Settings.
- ✅ Design: Manrope + IBM Plex Sans, monokrom + champagne #CBA135, Notion-style
  sidofält, sheet-baserad prospekt-detaljvy med AI-brief.
- ✅ AI-brief via Emergent LLM Key (Claude Sonnet 4.5).
- ⚠️ E-postpåminnelser implementerade men kräver att användaren lägger till
  RESEND_API_KEY + REMINDER_RECIPIENT i backend/.env.

## Backlog (P0/P1/P2)
- P1: Verifierad lista av Skandiamäklarnas faktiska kontor (just nu uppskattning baserat
  på publik info). Användaren kan komplettera via scrape.
- P1: LinkedIn / Hemnet-enrichment via riktiga API:er (just nu AI-baserad research).
- P2: Drag-and-drop på kanban för mobil (touch).
- P2: Notifieringar via Slack/SMS.
- P2: Cron-job för automatiska scheduled scrapes + mejl varje morgon.

## Next Tasks
1. Användaren fyller i RESEND_API_KEY (om e-post önskas aktivt).
2. Användaren validerar pipeline-flödet och korrigerar data.
3. Eventuell utbyggnad av AI-research med faktiska källor (LinkedIn/Hemnet).

## Phase 1 — Multi-user & Auth (2026-02 / iteration 2-3)
- ✅ JWT email/lösenord auth (httpOnly cookies + Bearer fallback)
- ✅ Två roller: admin + member. Admin seedad från .env (delfi@skandiamaklarna.se)
- ✅ Brute force-skydd: 5 misslyckade login/15 min per (ip+email), X-Forwarded-For-säkrad
- ✅ /team-sida: lista, bjud in, ändra roll, ta bort användare (admin only)
- ✅ owner_id + owner_name på prospekt; nya prospekt auto-tilldelas skaparen
- ✅ Pipeline-filter: Alla / Mina / Otilldelade / <användare>s prospekt
- ✅ Owner-väljare i ProspectSheet
- ✅ Aktivitetslogg loggar actor_id + actor_name; visas i feed
- ✅ /login-sida + ProtectedRoute + redirect-flow + Layout med logout-knapp
- ✅ Owner blir null automatiskt när användare tas bort (ej orphaned data)
- ✅ Test report: 32/33 backend + 100% frontend (enda kvarvarande: CORS preflight K8s ingress override — kosmetiskt)

## Phase 2 — Source, Lost-to, Stale alerts (2026-02 / iteration 4)
- ✅ Källa + referent på prospekt (source, source_detail, referred_by). 8 fördefinierade källor (LinkedIn, Rekommendation, Event/Mässa, Webbformulär, Cold outreach, Hemnet/Booli, Scrape, Annat)
- ✅ "Markera som förlorad"-flöde: dialog väljer konkurrent (12 kedjor) + skriver anledning. is_lost+lost_to_agency+lost_reason+lost_at sätts
- ✅ Förlorade prospekt försvinner från aktiva pipeline (kanban + sökning) men finns på /lost-sidan
- ✅ "Återställ"-flöde — för prospekt som ångrar sig
- ✅ Stale-alerts: prospekt med updated_at > 14 dgr (config via stale_days) markeras med orange/röd badge i kanban + listas på dashboard
- ✅ Ny KPI "Fastnat (>14 dgr)" på dashboard (ersätter "Aktiva objekt")
- ✅ Insights-sektion på dashboard: Källfördelning + Förlorade till + Topp 5 stale
- ✅ Nytt prospekt-dialog inkluderar källa + referent
- ✅ Backend: GET /api/stale-prospects, POST /api/prospects/{id}/lost, POST /api/prospects/{id}/restore, GET /api/dashboard/insights
- ✅ Test report: backend 14/14, frontend mark-lost flöde verifierat end-to-end

## Phase 2.5 — Lead Discovery Wizard (2026-02 / iteration 5)
- ✅ NY GET /api/discovery/{city} — returnerar curated länkar i 3 grupper:
  - Konkurrenters mäklare: Fastighetsbyrån, SvFf, Länsförsäkringar, HusmanHagberg, ERA, Bjurfors, Mäklarhuset, Notar (8 kedjor)
  - Branschregister: Mäklarsamfundet, Hemnet, Booli, Allabolag (4 källor)
  - Sociala/sökmotorer: LinkedIn (Google site:), Google Maps, Google News (4 sökgenvägar)
- ✅ NY POST /api/discovery/{city}/ai-strategy — Claude Sonnet genererar lokal lead-strategi för staden: marknadsbild, 4 kandidat-arketyper, 5 konkreta sökstrategier, pitch-vinklar, top-3-prioriteringar
- ✅ DiscoverySheet komponent — slide-out drawer kopplad till klick på white spot-tabellrad
- ✅ MapView: rader i white spots-tabellen är nu klickbara + "Discovery"-knapp
- ✅ "Skapa prospekt"-CTA i discovery sheet → navigerar till /pipeline med prefill (city, region, source)
- ✅ Pipeline lyssnar på location.state.prefill och auto-öppnar new-dialog
- ✅ GDPR-disclaimer i discovery-sheet (berättigat intresse, spara minimum)
- ✅ INGA ToS-brott — bara länkar till publika sökningar/register
- ✅ Aktivitetslogg loggar "ai_discovery" när AI-strategi genereras

## Phase 3 — Deal economics, Document storage, Onboarding (2026-02 / iteration 6)
- ✅ Anbudsekonomi på prospekt: signing_bonus, commission_split, guaranteed_salary, establishment_grant, start_date, contract_term_months, expected_first_year_revenue, economy_notes
- ✅ NY KPI "Pipeline-värde" på dashboard = sum(expected_first_year_revenue + signing_bonus) för aktiva prospekt, visas i kompakt format (1.4M, 350K)
- ✅ Dokumentlagring via Emergent Object Storage:
  - POST /api/prospects/{id}/files (multipart upload, max 15MB, allowed exts: pdf/doc/docx/xls/xlsx/png/jpg/jpeg/gif/webp/txt/csv/json)
  - GET /api/prospects/{id}/files (lista)
  - GET /api/files/{id}/download (binärt svar med Content-Disposition)
  - DELETE /api/files/{id} (soft delete)
  - Storage path: skandia-etablering/prospects/{prospect_id}/{user_id}/{uuid}.{ext}
  - Activity log per fil-upload + delete med uploaded_by/deleted_by
- ✅ Onboarding-checklista:
  - 11-stegs default template (välkomstmejl, IT-access, mentor, brand-paket, GDPR-utb., 30/60/90 check-ins, PR-launch, första objekt)
  - "Starta 30/60/90"-knapp initierar idempotent (säker att klicka flera ggr)
  - Toggle per steg → loggar completed_by + completed_at
  - Räknare "Onboarding (X/11)" i sektionens header
- ✅ ProspectSheet utökad med 3 nya sektioner (Ekonomi, Dokument, Onboarding) — flat scroll, samma design-språk
- ✅ Object storage initieras vid backend startup, ENV: EMERGENT_LLM_KEY (delas med LLM)

## Phase 4 — Office detail pages + Recruitment goals (Steg 6+7, 2026-02 / iteration 7)
- ✅ NY route /offices/:id — full office detail page
- ✅ Office detail: kontorsinfo (namn, adress, manager, region, tel, mejl), klickbar länk till skandiamaklarna.se
- ✅ 4 KPI-kort på detail: Mäklare-count, Aktiva objekt, Prospekt i stan, Rekryteringsmål (med färg: grön=i fas, röd=ligger efter)
- ✅ Steg 7 — Rekryteringsmodul: target_hires + deadline + status_note (kontorschefens flagga) + needs[] (tag-list)
- ✅ Auto-derived current_hires = prospects i samma stad med status Signerad eller Onboardad
- ✅ Visuell progress-bar (grön/röd baserat på ratio current/target)
- ✅ "Behov-taggar" med add/remove (BR-specialist, etc.)
- ✅ Aktiva mäklare-tabell + Prospekt-i-staden-tabell (med StatusPill)
- ✅ Tidslinje-sektion: aktivitetslogg filtrerad på prospect_id i kontorets stad
- ✅ Dashboard-rollup: "Rekrytering per kontor" — totals (i fas/efter mål/totalt mål) + topp 6 kontor med progress + "Öppna behov"-sidopanel
- ✅ Offices-sidan: rader klickbara → leder till detail-sidan
- ✅ Backend: GET /api/offices/{id} (utökat med goal+prospects+kpis+timeline), PUT /api/offices/{id}/recruitment, GET /api/dashboard/office-recruitment

## Phase 4.5 — Explicit office-coupling på prospekt (2026-02 / iteration 8)
- ✅ Nytt fält `office_id` på prospect (in/update models). `office_name` denormaliseras via _resolve_office helper
- ✅ POST /api/prospects + PATCH /api/prospects/{id} accepterar office_id; tom string nollställer
- ✅ GET /api/offices/{id} returnerar prospekt kopplade via explicit office_id PLUS legacy city-matchade utan dups (seen_ids-set)
- ✅ GET /api/dashboard/office-recruitment summerar explicit + city-fallback i samma rad (ingen dubbelräkning)
- ✅ Ny POST /api/offices/{id}/link-city-prospects — bulk-flyttar legacy city-matchade prospekt till explicit office_id
- ✅ Aktivitetslogg-entry "office_linked" när koppling ändras
- ✅ Pipeline "Nytt prospekt"-dialog har Kontor-select (data-testid `new-office`)
- ✅ ProspectSheet har Kontor-select (data-testid `prospect-office-select`) + visningsrad "Kopplad till {namn}"
- ✅ Kanban-kort visar "→ {office_name}" i guld när kopplat
- ✅ Bugfix: Python-syntaxfel i server.py rad 525 (kod på samma rad som funktionssignaturen för update_office_goal) fixat
- ✅ Test report iteration_5.json: 7/7 backend + 100% frontend end-to-end verifierat. Pytest-fil: /app/backend/tests/test_office_coupling.py

## Next Tasks (Backlog prioriterad)
- P1: "Glömt lösenord"-flöde via mejl (Resend)
- P1: "Min profil"-sida för användare att byta eget lösenord
- P2: Automatiska mejlpåminnelser via cron (Resend pipeline reminders)
- P2: Bulk-import av prospekt via Excel/CSV
- P2: Google Calendar-integration för bokade möten
- P3: Hemnet/Booli-scraping för antal sålda objekt per mäklare
- P3: Refaktorering — bryta upp /app/backend/server.py (~1750 rader) i routers/ (prospects, offices, auth, etc.)
