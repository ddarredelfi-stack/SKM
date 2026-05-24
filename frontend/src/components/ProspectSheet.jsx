import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Textarea } from "../components/ui/textarea";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  Sparkle,
  EnvelopeSimple,
  Trash,
  FloppyDisk,
  Phone,
  LinkedinLogo,
  XCircle,
  ArrowCounterClockwise,
  MapPin,
  Calendar,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, PIPELINE_STATUSES, PROSPECT_SOURCES, COMPETITOR_AGENCIES } from "../lib/api";
import StatusPill from "./StatusPill";

function renderMarkdown(md) {
  if (!md) return null;
  // Minimal markdown → HTML for AI brief: ### headings, **bold**, - lists
  const lines = md.split(/\r?\n/);
  const out = [];
  let listBuf = [];
  const flushList = () => {
    if (listBuf.length) {
      out.push(`<ul>${listBuf.map((l) => `<li>${l}</li>`).join("")}</ul>`);
      listBuf = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("### ")) {
      flushList();
      out.push(`<h3>${line.slice(4)}</h3>`);
    } else if (line.startsWith("- ") || line.startsWith("• ")) {
      listBuf.push(
        line.slice(2).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      );
    } else if (line === "") {
      flushList();
    } else {
      flushList();
      out.push(`<p>${line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`);
    }
  }
  flushList();
  return out.join("");
}

export default function ProspectSheet({ prospect, users = [], open, onOpenChange, onUpdated, onDeleted }) {
  const [form, setForm] = useState(prospect || {});
  const [saving, setSaving] = useState(false);
  const [briefLoading, setBriefLoading] = useState(false);
  const [emailLoading, setEmailLoading] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [lostDialogOpen, setLostDialogOpen] = useState(false);
  const [lostAgency, setLostAgency] = useState(COMPETITOR_AGENCIES[0]);
  const [lostReason, setLostReason] = useState("");
  const [lostBusy, setLostBusy] = useState(false);

  // Sync when prospect changes
  if (prospect && prospect.id !== form.id) {
    setForm(prospect);
  }

  if (!prospect) return null;

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.patch(`/prospects/${prospect.id}`, {
        name: form.name,
        type: form.type,
        current_agency: form.current_agency,
        city: form.city,
        region: form.region,
        phone: form.phone,
        email: form.email,
        linkedin: form.linkedin,
        status: form.status,
        notes: form.notes,
        next_step: form.next_step,
        next_step_date: form.next_step_date,
        owner_id: form.owner_id || "",
        source: form.source || "Annat",
        source_detail: form.source_detail || "",
        referred_by: form.referred_by || "",
      });
      toast.success("Prospekt uppdaterat");
      onUpdated?.(res.data);
      setForm(res.data);
    } catch (e) {
      toast.error("Kunde inte spara: " + (e.response?.data?.detail || e.message));
    } finally {
      setSaving(false);
    }
  };

  const markLost = async () => {
    if (!lostAgency.trim()) {
      toast.error("Välj kedja");
      return;
    }
    setLostBusy(true);
    try {
      const res = await api.post(`/prospects/${prospect.id}/lost`, {
        lost_to_agency: lostAgency,
        lost_reason: lostReason,
      });
      toast.success(`Markerad som förlorad till ${lostAgency}`);
      setForm(res.data);
      onUpdated?.(res.data);
      setLostDialogOpen(false);
      setLostReason("");
    } catch (e) {
      toast.error("Kunde inte markera: " + (e.response?.data?.detail || e.message));
    } finally {
      setLostBusy(false);
    }
  };

  const restore = async () => {
    if (!confirm(`Återställ ${form.name} till pipeline?`)) return;
    try {
      const res = await api.post(`/prospects/${prospect.id}/restore`);
      toast.success("Prospektet är tillbaka i pipelinen");
      setForm(res.data);
      onUpdated?.(res.data);
    } catch (e) {
      toast.error("Kunde inte återställa: " + (e.response?.data?.detail || e.message));
    }
  };

  const deleteProspect = async () => {
    if (!confirm(`Ta bort prospekt "${prospect.name}"?`)) return;
    try {
      await api.delete(`/prospects/${prospect.id}`);
      toast.success("Prospekt borttaget");
      onDeleted?.(prospect.id);
      onOpenChange(false);
    } catch (e) {
      toast.error("Kunde inte ta bort: " + e.message);
    }
  };

  const runBrief = async () => {
    setBriefLoading(true);
    try {
      const res = await api.post("/ai/research-brief", {
        prospect_id: prospect.id,
        name: form.name,
        city: form.city,
        current_agency: form.current_agency,
        notes: form.notes,
      });
      const updated = { ...form, ai_brief: res.data.brief };
      setForm(updated);
      onUpdated?.(updated);
      toast.success("AI-research klar");
    } catch (e) {
      toast.error("AI-fel: " + (e.response?.data?.detail || e.message));
    } finally {
      setBriefLoading(false);
    }
  };

  const sendReminder = async () => {
    setEmailLoading(true);
    try {
      const res = await api.post("/reminders/send", {
        prospect_id: prospect.id,
        recipient: recipient || undefined,
      });
      if (res.data.status === "success") {
        toast.success(res.data.message);
      } else if (res.data.status === "skipped") {
        toast.warning(res.data.message);
      } else {
        toast.error(res.data.message);
      }
    } catch (e) {
      toast.error("Kunde inte skicka: " + e.message);
    } finally {
      setEmailLoading(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[640px] overflow-y-auto bg-white border-l border-[#E5E5E5] p-0"
        data-testid="prospect-sheet"
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b border-[#E5E5E5]">
          <div className="overline">Värvningsprospekt</div>
          <SheetTitle className="font-display font-extrabold tracking-tight text-2xl text-[#0A0A0A]">
            {form.name}
          </SheetTitle>
          <SheetDescription className="sr-only">
            Redigera prospektet, generera AI-research, eller skicka en e-postpåminnelse.
          </SheetDescription>
          <div className="flex items-center gap-2 pt-1 flex-wrap">
            <StatusPill status={form.status} size="lg" />
            {form.city && (
              <span className="inline-flex items-center gap-1 text-xs text-[#52525B] font-body">
                <MapPin size={12} /> {form.city}
              </span>
            )}
            {form.current_agency && (
              <span className="text-xs text-[#52525B] font-body">· {form.current_agency}</span>
            )}
          </div>
        </SheetHeader>

        <div className="px-6 py-6 flex flex-col gap-6">
          {/* AI brief block */}
          <section className="card-surface p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="overline">AI Research-brief</div>
                <div className="text-[13px] text-[#52525B] mt-1 font-body">
                  Genererad analys baserat på namn, ort och kedja.
                </div>
              </div>
              <button
                data-testid="generate-brief-btn"
                onClick={runBrief}
                disabled={briefLoading}
                className="btn-primary inline-flex items-center gap-1.5"
              >
                <Sparkle size={14} weight="duotone" />
                {briefLoading ? "Genererar…" : form.ai_brief ? "Generera om" : "Generera"}
              </button>
            </div>
            {form.ai_brief ? (
              <div
                className="brief-prose mt-4"
                data-testid="ai-brief-content"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(form.ai_brief) }}
              />
            ) : (
              <div className="text-sm text-[#A1A1AA] py-6 text-center border border-dashed border-[#E5E5E5] rounded-md">
                Ingen brief genererad ännu.
              </div>
            )}
          </section>

          {/* Form */}
          <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label className="overline">Namn</Label>
              <Input
                data-testid="prospect-name-input"
                className="input-base mt-1.5"
                value={form.name || ""}
                onChange={(e) => update("name", e.target.value)}
              />
            </div>
            <div>
              <Label className="overline">Status</Label>
              <Select value={form.status} onValueChange={(v) => update("status", v)}>
                <SelectTrigger data-testid="prospect-status-select" className="input-base mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PIPELINE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="overline">Nuvarande kedja</Label>
              <Input
                data-testid="prospect-agency-input"
                className="input-base mt-1.5"
                value={form.current_agency || ""}
                onChange={(e) => update("current_agency", e.target.value)}
              />
            </div>
            <div>
              <Label className="overline">Ort</Label>
              <Input
                data-testid="prospect-city-input"
                className="input-base mt-1.5"
                value={form.city || ""}
                onChange={(e) => update("city", e.target.value)}
              />
            </div>
            <div>
              <Label className="overline">Telefon</Label>
              <Input
                data-testid="prospect-phone-input"
                className="input-base mt-1.5"
                value={form.phone || ""}
                onChange={(e) => update("phone", e.target.value)}
              />
            </div>
            <div>
              <Label className="overline">E-post</Label>
              <Input
                data-testid="prospect-email-input"
                className="input-base mt-1.5"
                value={form.email || ""}
                onChange={(e) => update("email", e.target.value)}
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="overline">LinkedIn</Label>
              <Input
                data-testid="prospect-linkedin-input"
                className="input-base mt-1.5"
                value={form.linkedin || ""}
                onChange={(e) => update("linkedin", e.target.value)}
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="overline">Ansvarig</Label>
              <Select
                value={form.owner_id || "__none__"}
                onValueChange={(v) => update("owner_id", v === "__none__" ? "" : v)}
              >
                <SelectTrigger data-testid="prospect-owner-select" className="input-base mt-1.5">
                  <SelectValue placeholder="Otilldelad" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Otilldelad</SelectItem>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.name} {u.role === "admin" ? "· admin" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="overline">Källa</Label>
              <Select
                value={form.source || "Annat"}
                onValueChange={(v) => update("source", v)}
              >
                <SelectTrigger data-testid="prospect-source-select" className="input-base mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROSPECT_SOURCES.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="overline">Referent / detalj</Label>
              <Input
                data-testid="prospect-referred-by-input"
                className="input-base mt-1.5"
                placeholder="t.ex. Pia Hansson eller Mäklarmässan -25"
                value={form.referred_by || form.source_detail || ""}
                onChange={(e) => update("referred_by", e.target.value)}
              />
            </div>
            <div>
              <Label className="overline">Nästa steg</Label>
              <Input
                data-testid="prospect-next-step-input"
                className="input-base mt-1.5"
                placeholder="t.ex. Lunchmöte"
                value={form.next_step || ""}
                onChange={(e) => update("next_step", e.target.value)}
              />
            </div>
            <div>
              <Label className="overline">Datum</Label>
              <Input
                type="date"
                data-testid="prospect-next-date-input"
                className="input-base mt-1.5"
                value={(form.next_step_date || "").slice(0, 10)}
                onChange={(e) => update("next_step_date", e.target.value)}
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="overline">Anteckningar</Label>
              <Textarea
                data-testid="prospect-notes-input"
                className="input-base mt-1.5 min-h-[120px] font-body"
                value={form.notes || ""}
                onChange={(e) => update("notes", e.target.value)}
              />
            </div>
          </section>

          {/* Reminder */}
          <section className="card-surface p-5">
            <div className="flex items-center gap-2 mb-2">
              <EnvelopeSimple size={16} color="#CBA135" weight="duotone" />
              <div className="font-display font-bold text-sm">E-postpåminnelse</div>
            </div>
            <p className="text-[12px] text-[#52525B] font-body mb-3">
              Skickar en kort sammanfattning med nästa-steg-datum till mottagaradressen
              (Resend krävs i .env).
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                data-testid="reminder-recipient-input"
                placeholder="din@email.se (lämna tomt för REMINDER_RECIPIENT)"
                className="input-base flex-1"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              />
              <button
                data-testid="send-reminder-btn"
                onClick={sendReminder}
                disabled={emailLoading}
                className="btn-secondary inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <EnvelopeSimple size={14} /> {emailLoading ? "Skickar…" : "Skicka"}
              </button>
            </div>
          </section>

          <div className="flex justify-between items-center pt-2 flex-wrap gap-2">
            <div className="flex gap-2">
              <button
                data-testid="delete-prospect-btn"
                onClick={deleteProspect}
                className="btn-ghost inline-flex items-center gap-1.5 text-[#DC2626] hover:text-[#DC2626]"
              >
                <Trash size={14} /> Ta bort
              </button>
              {form.is_lost ? (
                <button
                  data-testid="restore-prospect-btn"
                  onClick={restore}
                  className="btn-ghost inline-flex items-center gap-1.5"
                >
                  <ArrowCounterClockwise size={14} /> Återställ
                </button>
              ) : (
                <button
                  data-testid="mark-lost-btn"
                  onClick={() => setLostDialogOpen(true)}
                  className="btn-ghost inline-flex items-center gap-1.5 text-[#DC2626] hover:text-[#DC2626]"
                >
                  <XCircle size={14} /> Markera som förlorad
                </button>
              )}
            </div>
            <button
              data-testid="save-prospect-btn"
              onClick={save}
              disabled={saving}
              className="btn-primary inline-flex items-center gap-1.5"
            >
              <FloppyDisk size={14} /> {saving ? "Sparar…" : "Spara ändringar"}
            </button>
          </div>

          {form.is_lost && (
            <div
              data-testid="lost-banner"
              className="card-surface p-4 border border-[#FECACA] bg-[#FEF2F2]"
            >
              <div className="flex items-center gap-2 mb-1">
                <XCircle size={16} weight="duotone" color="#DC2626" />
                <div className="font-display font-extrabold text-[#7F1D1D] text-sm uppercase tracking-wider">
                  Förlorad till {form.lost_to_agency || "—"}
                </div>
              </div>
              {form.lost_reason && (
                <p className="text-[13px] text-[#7F1D1D] font-body">{form.lost_reason}</p>
              )}
              <p className="text-[11px] text-[#A33] font-display font-semibold uppercase tracking-wider mt-2">
                {form.lost_at ? new Date(form.lost_at).toLocaleString("sv-SE") : ""}
              </p>
            </div>
          )}

          {/* Contact quick links */}
          {(form.phone || form.email || form.linkedin) && (
            <div className="flex flex-wrap gap-2 pt-2">
              {form.phone && (
                <a href={`tel:${form.phone}`} className="btn-secondary inline-flex items-center gap-1.5 text-xs">
                  <Phone size={12} /> {form.phone}
                </a>
              )}
              {form.email && (
                <a href={`mailto:${form.email}`} className="btn-secondary inline-flex items-center gap-1.5 text-xs">
                  <EnvelopeSimple size={12} /> {form.email}
                </a>
              )}
              {form.linkedin && (
                <a href={form.linkedin} target="_blank" rel="noreferrer" className="btn-secondary inline-flex items-center gap-1.5 text-xs">
                  <LinkedinLogo size={12} /> LinkedIn
                </a>
              )}
            </div>
          )}

          {form.next_step_date && (
            <div className="text-xs text-[#52525B] flex items-center gap-1.5 font-body">
              <Calendar size={12} />
              Nästa steg: <strong className="text-[#0A0A0A]">{form.next_step}</strong> ·{" "}
              <span className="text-[#CBA135] font-display font-bold">
                {(form.next_step_date || "").slice(0, 10)}
              </span>
            </div>
          )}
        </div>
      </SheetContent>

      <Dialog open={lostDialogOpen} onOpenChange={setLostDialogOpen}>
        <DialogContent className="sm:max-w-[480px] bg-white" data-testid="lost-dialog">
          <DialogHeader>
            <div className="overline">Markera som förlorad</div>
            <DialogTitle className="font-display font-extrabold tracking-tight text-2xl">
              Vart gick {form.name}?
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 mt-2">
            <div>
              <Label className="overline">Konkurrent</Label>
              <Select value={lostAgency} onValueChange={setLostAgency}>
                <SelectTrigger data-testid="lost-agency-select" className="input-base mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMPETITOR_AGENCIES.map((a) => (
                    <SelectItem key={a} value={a}>{a}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="overline">Anledning (kort)</Label>
              <Textarea
                data-testid="lost-reason-input"
                placeholder="t.ex. bättre lön, närmare bostad, tackade ja till annat erbjudande"
                className="input-base mt-1 font-body"
                value={lostReason}
                onChange={(e) => setLostReason(e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setLostDialogOpen(false)} className="btn-ghost">
              Avbryt
            </button>
            <button
              data-testid="confirm-mark-lost"
              onClick={markLost}
              disabled={lostBusy}
              className="btn-primary inline-flex items-center gap-1.5"
            >
              <XCircle size={14} /> {lostBusy ? "Markerar…" : "Markera som förlorad"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </Sheet>
  );
}
