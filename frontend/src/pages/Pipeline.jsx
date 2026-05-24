import { useEffect, useMemo, useState } from "react";
import { Plus, MagnifyingGlass, DownloadSimple, UserCircle } from "@phosphor-icons/react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { api, PIPELINE_STATUSES, STATUS_TONE, downloadCsv, formatDate } from "../lib/api";
import { useAuth } from "../lib/auth";
import ProspectSheet from "../components/ProspectSheet";

const empty = {
  name: "",
  type: "broker",
  current_agency: "",
  city: "",
  region: "",
  phone: "",
  email: "",
  linkedin: "",
  status: "Identifierad",
  notes: "",
  next_step: "",
  next_step_date: "",
};

export default function Pipeline() {
  const [data, setData] = useState({ grouped: {}, items: [], statuses: PIPELINE_STATUSES });
  const [q, setQ] = useState("");
  const [openDialog, setOpenDialog] = useState(false);
  const [form, setForm] = useState(empty);
  const [selected, setSelected] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [dragOver, setDragOver] = useState(null);

  const load = async () => {
    const res = await api.get("/prospects", { params: { q } });
    setData(res.data);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const create = async () => {
    if (!form.name.trim()) {
      toast.error("Namn krävs");
      return;
    }
    try {
      await api.post("/prospects", form);
      toast.success("Prospekt skapat");
      setForm(empty);
      setOpenDialog(false);
      load();
    } catch (e) {
      toast.error("Fel: " + (e.response?.data?.detail || e.message));
    }
  };

  const updateStatus = async (id, newStatus) => {
    try {
      await api.patch(`/prospects/${id}/status`, { status: newStatus });
      load();
    } catch (e) {
      toast.error("Kunde inte flytta: " + e.message);
    }
  };

  const onDragStart = (id) => setDragId(id);
  const onDragEnd = () => {
    setDragId(null);
    setDragOver(null);
  };
  const onDragOver = (e, status) => {
    e.preventDefault();
    setDragOver(status);
  };
  const onDrop = (status) => {
    if (dragId) updateStatus(dragId, status);
    onDragEnd();
  };

  const totalShown = useMemo(
    () => (data.items || []).length,
    [data]
  );

  return (
    <div data-testid="pipeline-page" className="flex flex-col gap-6">
      <header className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
        <div>
          <div className="overline">Värvning</div>
          <h1 className="font-display font-extrabold tracking-tighter text-[#0A0A0A] text-4xl mt-1">
            Pipeline
          </h1>
          <p className="text-[#52525B] text-sm mt-2 font-body">
            Dra prospekt mellan kolumner för att uppdatera status. {totalShown} prospekt totalt.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <Select value={ownerFilter} onValueChange={setOwnerFilter}>
            <SelectTrigger data-testid="owner-filter" className="input-base w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alla prospekt</SelectItem>
              <SelectItem value="me">Mina prospekt</SelectItem>
              <SelectItem value="unassigned">Otilldelade</SelectItem>
              {users.filter((u) => u.id !== user?.id).map((u) => (
                <SelectItem key={u.id} value={u.id}>{u.name}s prospekt</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative">
            <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A1A1AA]" />
            <Input
              data-testid="pipeline-search"
              className="input-base pl-8 w-64"
              placeholder="Sök prospekt, ort, kedja…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <button
            data-testid="export-prospects-csv"
            onClick={() => downloadCsv("/export/prospects.csv", "skandia-prospekt.csv")}
            className="btn-secondary inline-flex items-center gap-1.5"
          >
            <DownloadSimple size={14} /> CSV
          </button>
          <Dialog open={openDialog} onOpenChange={setOpenDialog}>
            <DialogTrigger asChild>
              <button data-testid="new-prospect-btn" className="btn-primary inline-flex items-center gap-1.5">
                <Plus size={14} /> Nytt prospekt
              </button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[520px] bg-white" data-testid="new-prospect-dialog">
              <DialogHeader>
                <div className="overline">Nytt prospekt</div>
                <DialogTitle className="font-display font-extrabold tracking-tight text-2xl">
                  Lägg till värvningsprospekt
                </DialogTitle>
              </DialogHeader>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                <div className="sm:col-span-2">
                  <Label className="overline">Namn *</Label>
                  <Input
                    data-testid="new-name"
                    className="input-base mt-1"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div>
                  <Label className="overline">Typ</Label>
                  <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
                    <SelectTrigger data-testid="new-type" className="input-base mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="broker">Mäklare</SelectItem>
                      <SelectItem value="office">Nytt kontor</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="overline">Status</Label>
                  <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                    <SelectTrigger data-testid="new-status" className="input-base mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PIPELINE_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="overline">Nuvarande kedja</Label>
                  <Input data-testid="new-agency" className="input-base mt-1" value={form.current_agency} onChange={(e) => setForm({ ...form, current_agency: e.target.value })} />
                </div>
                <div>
                  <Label className="overline">Ort</Label>
                  <Input data-testid="new-city" className="input-base mt-1" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
                </div>
                <div>
                  <Label className="overline">Telefon</Label>
                  <Input className="input-base mt-1" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </div>
                <div>
                  <Label className="overline">E-post</Label>
                  <Input className="input-base mt-1" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </div>
                <div className="sm:col-span-2">
                  <Label className="overline">Anteckningar</Label>
                  <Textarea className="input-base mt-1 font-body" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-4">
                <button onClick={() => setOpenDialog(false)} className="btn-ghost">Avbryt</button>
                <button data-testid="confirm-new-prospect" onClick={create} className="btn-primary">Skapa</button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </header>

      <div className="flex gap-3 overflow-x-auto scrollbar-thin pb-3" data-testid="kanban-board">
        {PIPELINE_STATUSES.map((status) => {
          const items = data.grouped[status] || [];
          const tone = STATUS_TONE[status];
          return (
            <div
              key={status}
              data-testid={`kanban-col-${status}`}
              className={`kanban-col ${dragOver === status ? "drag-over" : ""}`}
              onDragOver={(e) => onDragOver(e, status)}
              onDragLeave={() => setDragOver(null)}
              onDrop={() => onDrop(status)}
            >
              <div className="flex items-center justify-between mb-1 px-1">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: tone.dot }} />
                  <span className="font-display font-bold text-[13px] text-[#0A0A0A]">{status}</span>
                </div>
                <span className="text-[11px] font-display font-bold text-[#52525B] tabular-nums">
                  {items.length}
                </span>
              </div>
              <div className="flex flex-col gap-2 overflow-y-auto scrollbar-thin">
                {items.map((p) => (
                  <div
                    key={p.id}
                    data-testid={`kanban-card-${p.id}`}
                    className={`kanban-card ${dragId === p.id ? "dragging" : ""}`}
                    draggable
                    onDragStart={() => onDragStart(p.id)}
                    onDragEnd={onDragEnd}
                    onClick={() => {
                      setSelected(p);
                      setSheetOpen(true);
                    }}
                  >
                    <div className="font-display font-extrabold text-[14px] text-[#0A0A0A] leading-tight">
                      {p.name}
                    </div>
                    <div className="text-[12px] text-[#52525B] mt-0.5 font-body">
                      {p.city || "—"} {p.current_agency ? ` · ${p.current_agency}` : ""}
                    </div>
                    {p.next_step_date && (
                      <div className="mt-2 text-[11px] text-[#7C5A0F] bg-[#FAF3E1] inline-block px-2 py-0.5 rounded font-display font-bold">
                        {p.next_step || "Nästa steg"} · {formatDate(p.next_step_date)}
                      </div>
                    )}
                    <div className="mt-2 flex items-center justify-between gap-1">
                      <div className="flex items-center gap-1.5 text-[11px] text-[#52525B] font-body min-w-0">
                        <UserCircle size={12} weight={p.owner_id ? "fill" : "regular"}
                          color={p.owner_id ? "#CBA135" : "#A1A1AA"} />
                        <span className="truncate">{p.owner_name || "Otilldelad"}</span>
                      </div>
                    </div>
                    {p.tags?.length > 0 && (
                      <div className="mt-2 flex gap-1 flex-wrap">
                        {p.tags.map((t) => (
                          <span key={t} className="text-[10px] uppercase tracking-wider font-display font-bold text-[#52525B] bg-[#F4F4F5] px-1.5 py-0.5 rounded">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {!items.length && (
                  <div className="text-[12px] text-[#A1A1AA] text-center py-6 border border-dashed border-[#E5E5E5] rounded-md">
                    Inget prospekt
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <ProspectSheet
        prospect={selected}
        users={users}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onUpdated={() => load()}
        onDeleted={() => load()}
      />
    </div>
  );
}
