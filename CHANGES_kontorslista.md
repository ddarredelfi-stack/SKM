# Ändringar — kontorslistan invävd (2026-07-08)

Vad som är gjort, varför, och hur du kör det. Allt är testat lokalt (backend
mot en in-memory Mongo, frontend syntax- och importkontrollerad med esbuild)
men INTE körkört mot din riktiga databas/deploy — se "Att göra" nedan.

## Vad som är nytt

**`backend/real_offices_data.py`** (ny fil)
De 80 kontoren från din kontorslista (Kontorslista_RGG_Jan-feb_2025-260316_vHK.xlsx):
namn, ort, region, ungefärliga koordinater, kategori (PROBLEM/UTMANINGAR/OK),
prio 1–5, omsättning i år/ifjol, sålda objekt, kommentar, och för de 18
Prio 1-kontoren en konkret åtgärdsrekommendation. Plus en separat lista med
de 11 kommersiella/vilande enheterna som saknar prio i underlaget.

**`backend/seed_data.py`** (ändrad)
`build_seed()` bygger nu kontor från `real_offices_data.py` istället för den
påhittade 30-kontorslistan. Mäklarantal per kontor skalas efter faktiskt
sålda objekt istället för att vara helt slumpat. Kontorschef sätts till
första genererade mäklaren (riktiga namn saknas i underlaget — ersätts
automatiskt när "Scraping"-funktionen körs, eller fyll i manuellt).

**`backend/server.py`** (ändrad)
- `GET /offices` tar nu emot `kategori`, `prio` och `sort` (name/prio/oms/yoy)
- Ny endpoint `GET /offices/extra-units` — de 11 ej prioriterade enheterna
- `GET /dashboard/kpis` innehåller nu `office_performance` (kategori-fördelning,
  antal Prio 1, total omsättning + YoY)
- `POST /scrape/sync` (full synk mot skandiamaklarna.se) skriver inte längre
  över kategori/prio/omsättning/kommentar — de matchas och bevaras via
  ort-namn innan kontoren ersätts, så en framtida scrape inte tystar bort
  kontorslistans data
- `GET /export/offices.csv` innehåller nu kategori/prio/omsättning/YoY/kommentar

**`backend/migrate_real_offices.py`** (ny fil, se "Att göra" nedan)

**Frontend**
- `Kontor`-sidan: kategori-badge, prio, omsättning, YoY, filter på
  kategori/prio, sortering
- Kontorsdetaljsidan: ny "Prestanda"-sektion med omsättning/YoY/sålda objekt/
  kommentar, plus rekommenderad åtgärd för Prio 1-kontor
- Ny sida **Akutlista** (`/akutlista`, i sidomenyn) — samtliga 18 Prio 1-kontor
  med åtgärdsförslag, samma innehåll som den fristående dashboarden vi byggde
- Översikten (Dashboard) har en ny ruta med kategori-fördelning + länk till
  Akutlistan

## Att göra innan det är live för fler på kontoret

1. **Om databasen redan är seedad** (dvs. appen redan körts någon gång, t.ex.
   på Emergent) skriver inte startup-koden över den automatiskt — kör då
   `python backend/migrate_real_offices.py` (dry run, skriver ingenting) och
   sen `python backend/migrate_real_offices.py --apply` för att byta ut de
   påhittade 30 kontoren mot de riktiga 80, med bästa-försök-omlänkning av
   befintliga prospekt/mål baserat på ortnamn. Tar backup automatiskt först.
   Om databasen är helt tom seedas det nya datasetet automatiskt vid start.
2. **Adresser/telefonnummer/kontorschefer saknas** för de riktiga kontoren
   (fanns inte i Excel-underlaget) — fylls i antingen manuellt eller via
   "Scraping"-sidans "Full sync" (hämtar publik info från skandiamaklarna.se;
   kategori/prio/omsättning bevaras enligt ovan).
3. Inte gjort än: flera-användare-delen (inloggning/roller) fanns redan i
   appen sedan tidigare (Fas 1) — inget nytt behövs för att flera på kontoret
   ska kunna logga in, bara att skapa konton via "Mitt team"-sidan.
4. Live-deploy (utanför Emergent) är inte påbörjat — hör av dig när ni är
   redo så tittar vi på det (Vercel för frontend + Supabase/annan Postgres
   eller fortsatt Mongo för backend är rimliga vägar).
