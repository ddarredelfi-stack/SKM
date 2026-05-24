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
