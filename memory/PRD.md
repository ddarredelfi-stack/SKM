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
