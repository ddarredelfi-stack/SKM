"""AI research brief generator for värvningsprospekt.

Uses Emergent LLM Key + Claude Sonnet 4.5 via emergentintegrations.
"""
from __future__ import annotations
import os
import logging
import uuid

from emergentintegrations.llm.chat import LlmChat, UserMessage

logger = logging.getLogger(__name__)


SYSTEM_PROMPT = """Du är en strategisk research-analytiker som hjälper en etableringschef på Skandiamäklarna att förbereda värvningssamtal med fastighetsmäklare i Sverige.

Du genererar en kort, faktabaserad och konkret research-brief på SVENSKA i strikt Markdown-format med följande sektioner. Var direkt och affärsmässig — nollfluff.

**Format (strikt):**

### Sammanfattning
2-3 meningar om vem detta sannolikt är (utifrån namn, ort och kedja). Var ärlig med osäkerhet.

### Värvningsvinkel
3-4 punkter — varför skulle denna mäklare passa Skandiamäklarna? Vad är typiska smärtpunkter hos en mäklare på {agency} i {city}?

### Marknadsläge i {city}
2-3 punkter om lokala bostadsmarknaden, kedjornas närvaro och möjligheter.

### Öppningsfrågor
4-5 konkreta samtalsfrågor som etableringschefen kan ställa i första kontakten.

### Källor att kontrollera
Lista 3-5 publika källor (Hemnet, LinkedIn, Mäklarsamfundet, Allabolag, lokal press) som etableringschefen själv bör verifiera. Var tydlig: detta är hypoteser, inte fakta.

Använd aldrig påhittade siffror som om de vore verifierade. När du gissar, säg "uppskattning" eller "sannolikt"."""


DISCOVERY_PROMPT = """Du är en sourcing-strateg som hjälper en etableringschef på Skandiamäklarna att hitta mäklare att värva i en stad där Skandia INTE har kontor. Generera en konkret aktionsplan på SVENSKA i strikt Markdown.

**Stad:** {city}
**Region:** {region}
**Befolkning:** {population}
**Uppskattade bostadstransaktioner/år:** {transactions}
**Konkurrenter på plats:** {competitors}

Format (strikt):

### Marknadsbild i {city}
2-3 punkter om vad som karaktäriserar mäklarmarknaden här — storlek, dominerande aktörer, om det är lokala vs rikstäckande kedjor som styr.

### Kandidat-profiler att leta efter
4 distinkta arketyper av mäklare som sannolikt skulle byta till Skandia just nu. För varje: 1 mening om profilen + 1 mening om varför de skulle vilja byta. Var konkret (t.ex. "Kontorschef på lokal aktör som vill ta steget mot rikstäckande varumärke").

### Konkreta sökstrategier
5 specifika åtgärder etableringschefen kan göra IDAG för att hitta namn. Var operativ: ge exakta sökfraser, register att kolla, telefonbok-tips, branschrelationer att utnyttja.

### Första kontakt-pitch (specifik för {city})
3-4 punkter om vad som funkar i värvningssamtal *just här* — vad är Skandias edge mot konkurrenterna i denna stad?

### Top 3 prioriteringar
Numrerad lista. Vad bör göras först, denna vecka, för att etablera närvaro i {city}?

Var direkt, nollfluff. Använd "uppskattning" eller "sannolikt" när du gissar."""


async def generate_brief(name: str, city: str, agency: str, notes: str = "") -> str:
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise RuntimeError("EMERGENT_LLM_KEY saknas i .env")

    chat = LlmChat(
        api_key=api_key,
        session_id=f"brief-{uuid.uuid4()}",
        system_message=SYSTEM_PROMPT.format(agency=agency or "okänd kedja", city=city or "okänd ort"),
    ).with_model("anthropic", "claude-sonnet-4-6")

    user_text = (
        f"Generera research-brief för värvningsprospekt:\n\n"
        f"- Namn: {name}\n"
        f"- Ort: {city or 'okänd'}\n"
        f"- Nuvarande kedja: {agency or 'okänd'}\n"
        f"- Mina anteckningar: {notes or '(inga)'}\n\n"
        f"Skriv på svenska enligt det fasta formatet."
    )
    response = await chat.send_message(UserMessage(text=user_text))
    return response if isinstance(response, str) else str(response)


async def generate_discovery_strategy(
    city: str,
    region: str = "",
    population: int = 0,
    transactions: int = 0,
    competitors: list[str] | None = None,
) -> str:
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise RuntimeError("EMERGENT_LLM_KEY saknas i .env")

    comps_str = ", ".join(competitors) if competitors else "okänt"
    chat = LlmChat(
        api_key=api_key,
        session_id=f"discovery-{uuid.uuid4()}",
        system_message=DISCOVERY_PROMPT.format(
            city=city or "okänd ort",
            region=region or "okänd region",
            population=f"{population:,}".replace(",", " ") if population else "okänd",
            transactions=f"{transactions:,}".replace(",", " ") if transactions else "okänd",
            competitors=comps_str,
        ),
    ).with_model("anthropic", "claude-sonnet-4-6")

    user_text = (
        f"Skapa en lead-discovery-aktionsplan för {city}. "
        f"Skandiamäklarna har inget kontor här idag. "
        f"Använd det fasta formatet i system-prompten."
    )
    response = await chat.send_message(UserMessage(text=user_text))
    return response if isinstance(response, str) else str(response)
