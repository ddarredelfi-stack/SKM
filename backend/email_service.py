"""Resend email service — used for prospect follow-up reminders."""
from __future__ import annotations
import asyncio
import logging
import os

import resend

logger = logging.getLogger(__name__)


def _configured() -> bool:
    key = os.environ.get("RESEND_API_KEY", "")
    return bool(key and key.strip())


async def send_reminder(recipient: str, subject: str, html: str) -> dict:
    """Send a reminder email via Resend.

    Returns {"status": "success"|"skipped"|"error", "message": "...", "email_id": "..."}
    """
    if not _configured():
        return {
            "status": "skipped",
            "message": "RESEND_API_KEY ej konfigurerad — påminnelse loggad men inte skickad.",
        }
    if not recipient:
        return {"status": "error", "message": "Saknar mottagaradress."}

    resend.api_key = os.environ["RESEND_API_KEY"]
    sender = os.environ.get("SENDER_EMAIL", "onboarding@resend.dev")
    params = {
        "from": sender,
        "to": [recipient],
        "subject": subject,
        "html": html,
    }
    try:
        email = await asyncio.to_thread(resend.Emails.send, params)
        return {
            "status": "success",
            "message": f"Mejl skickat till {recipient}",
            "email_id": email.get("id") if isinstance(email, dict) else None,
        }
    except Exception as e:
        logger.exception("Resend error")
        return {"status": "error", "message": str(e)}


def build_notification_html(message: str, kind: str, actor: str, when: str) -> str:
    return f"""<!doctype html>
<html><body style="font-family:Arial,Helvetica,sans-serif;background:#FAFAFA;padding:0;margin:0;color:#0A0A0A;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAFA;padding:32px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1px solid #E5E5E5;border-radius:8px;">
<tr><td style="padding:32px;">
<p style="margin:0 0 4px 0;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#52525B;">Skandiamäklarna · Etablering</p>
<h1 style="margin:0 0 20px 0;font-size:20px;font-weight:800;color:#0A0A0A;">{message}</h1>
<p style="margin:0 0 6px 0;font-size:13px;color:#52525B;">Av: {actor}</p>
<p style="margin:0 0 6px 0;font-size:13px;color:#52525B;">Typ: {kind}</p>
<p style="margin:0;font-size:13px;color:#52525B;">Tidpunkt: {when}</p>
</td></tr>
</table>
<p style="margin:16px 0 0 0;font-size:11px;color:#A1A5AB;">Automatisk avisering från Etablering-verktyget.</p>
</td></tr>
</table>
</body></html>"""


def build_reminder_html(prospect_name: str, next_step: str, next_step_date: str,
                        city: str, current_agency: str, notes: str = "") -> str:
    return f"""<!doctype html>
<html><body style="font-family:Arial,Helvetica,sans-serif;background:#FAFAFA;padding:0;margin:0;color:#0A0A0A;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAFA;padding:32px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1px solid #E5E5E5;border-radius:8px;">
<tr><td style="padding:32px;">
<p style="margin:0 0 4px 0;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#52525B;">Skandiamäklarna · Etablering</p>
<h1 style="margin:0 0 24px 0;font-size:24px;font-weight:800;color:#0A0A0A;">Påminnelse: {next_step}</h1>
<p style="margin:0 0 8px 0;font-size:14px;color:#52525B;">Prospekt</p>
<p style="margin:0 0 16px 0;font-size:18px;font-weight:600;color:#0A0A0A;">{prospect_name}</p>
<table cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;font-size:13px;color:#52525B;">
<tr><td style="padding:4px 16px 4px 0;color:#52525B;">Ort</td><td style="color:#0A0A0A;font-weight:600;">{city or '—'}</td></tr>
<tr><td style="padding:4px 16px 4px 0;color:#52525B;">Nuvarande kedja</td><td style="color:#0A0A0A;font-weight:600;">{current_agency or '—'}</td></tr>
<tr><td style="padding:4px 16px 4px 0;color:#52525B;">Nästa steg</td><td style="color:#0A0A0A;font-weight:600;">{next_step or '—'}</td></tr>
<tr><td style="padding:4px 16px 4px 0;color:#52525B;">Datum</td><td style="color:#CBA135;font-weight:700;">{next_step_date or '—'}</td></tr>
</table>
{('<p style="margin:0 0 24px 0;font-size:13px;color:#52525B;border-left:3px solid #CBA135;padding:8px 12px;background:#FAFAFA;">' + notes + '</p>') if notes else ''}
<p style="margin:24px 0 0 0;font-size:11px;color:#A1A1AA;">Skickat från din etableringschef-dashboard.</p>
</td></tr></table>
</td></tr></table>
</body></html>"""
