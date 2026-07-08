import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  MapPin,
  Phone,
  EnvelopeSimple,
  ArrowSquareOut,
  ArrowLeft,
  Crown,
  Target,
  Plus,
  X,
  FloppyDisk,
  Warning,
  CheckCircle,
  Clock,
  LinkSimple,
  ChartLineUp,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, formatDate, formatDateTime, formatSEK, formatPct, STATUS_TONE } from "../lib/api";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import StatusPill from "../components/StatusPill";
import KategoriPill from "../components/KategoriPill";
import ActivityFeed from "../components/ActivityFeed";

export default function OfficeDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [goalForm, setGoalForm] = useState({
    target_hires: 0,
    deadline: "",
    status_note: "",
    needs: [],
  });
  const [newNeed, setNewNeed] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const res = await api.get(`/offices/${id}`);
    setData(res.data);
    const g = res.data.goal;
    setGoalForm({
      target_hires: g?.target_hires ?? 0,
      deadline: (g?.deadline || "").slice(0, 10),
      status_note: g?.status_note ?? "",
      needs: g?.needs ?? [],
    });
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const saveGoal = async () => {
    setSaving(true);
    try {
      await api.put(`/offices/${id}/recruitment`, {
        target_hires: Number(goalForm.target_hires) || 0,
        deadline: goalForm.deadline || null,
        status_note: goalForm.status_note,
        needs: goalForm.needs,
      });
      toast.success("Rekryteringsmål sparat");
      load();
    } catch (e) {
      toast.error("Kunde inte spara: " + (e.response?.data?.detail || e.message));
    } finally {
      setSaving(false);
    }
  };

  const addNeed = () => {
    if (!newNeed.trim()) return;
    setGoalForm((f) => ({ ...f, needs: [...f.needs, newNeed.trim()] }));
    setNewNeed("");
  };

  const removeNeed = (idx) => {
    setGoalForm((f) => ({ ...f, needs: f.needs.filter((_, i) => i !== idx) }));
  };

  const linkCityProspects = async () => {
    const unlinkedCount = (data?.prospects || []).filter(
      (p) => !p.office_id
    ).length;
    if (!unlinkedCount) {
      toast.info("Inga ogkopplade prospekt att migrera");
      return;
    }
    if (
      !confirm(
        `Länka ${unlinkedCount} stadsmatchade prospekt explicit till ${data.office.name}?`
      )
    )
      return;
    try {
      const res = await api.post(`/offices/${id}/link-city-prospects`);
      toast.success(`${res.data.linked} prospekt kopplade till ${res.data.office_name}`);
      load();
    } catch (e) {
      toast.error("Fel: " + (e.response?.data?.detail || e.message));
    }
  };

  if (!data) {
    return <div className="text-sm text-[#52525B]">Laddar kontor…</div>;
  }

  const { office, brokers, prospects, kpis, timeline, goal } = data;
  const target = goal?.target_hires || 0;
  const pct = target > 0 ? Math.min(100, Math.round((kpis.signed_or_onboarded / target) * 100)) : 0;
  const status = target === 0 ? "no_goal" : (kpis.signed_or_onboarded / target >= 0.5 ? "on_track" : "behind");

  return (
    <div data-testid="office-detail-page" className="flex flex-col gap-6">
      <div>
        <Link
          to="/offices"
          data-testid="back-to-offices"
          className="btn-ghost inline-flex items-center gap-1 text-xs"
        >
          <ArrowLeft size={12} /> Alla kontor
        </Link>
      </div>

      <header className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <div>
          <div className="overline">Kontor</div>
          <h1 className="font-display font-extrabold tracking-tighter text-[#0A0A0A] text-4xl mt-1 flex items-center gap-3">
            {office.name}
            {office.website && (
              <a
                href={office.website}
                target="_blank"
                rel="noreferrer"
                data-testid="office-website-link"
                className="text-[#A1A1AA] hover:text-[#CBA135]"
              >
                <ArrowSquareOut size={20} weight="bold" />
              </a>
            )}
          </h1>
          <p className="text-[#52525B] text-sm mt-2 font-body flex items-center gap-1.5">
            <MapPin size={12} /> {office.address || office.city}
            <span className="text-[#D4D4D8]">·</span>
            <span>{office.region}</span>
          </p>
          {office.manager && (
            <p className="text-[#52525B] text-sm mt-1 font-body flex items-center gap-1.5">
              <Crown size={12} color="#CBA135" weight="duotone" />
              Kontorschef: <strong className="text-[#0A0A0A] font-display">{office.manager}</strong>
            </p>
          )}
        </div>
        <div className="flex gap-3">
          {office.phone && (
            <a href={`tel:${office.phone}`} className="btn-secondary inline-flex items-center gap-1.5 text-xs">
              <Phone size={12} /> {office.phone}
            </a>
          )}
          {office.email && (
            <a href={`mailto:${office.email}`} className="btn-secondary inline-flex items-center gap-1.5 text-xs">
              <EnvelopeSimple size={12} /> Mejla
            </a>
          )}
        </div>
      </header>

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiBlock label="Mäklare" value={kpis.broker_count} sub="Aktiva på kontoret" testId="kpi-brokers" />
        <KpiBlock label="Aktiva objekt" value={kpis.listing_count} sub={kpis.listing_count ? "I databas" : "(ej synkat)"} testId="kpi-listings" />
        <KpiBlock label="Prospekt i stan" value={kpis.active_prospects} sub={`${kpis.signed_or_onboarded} signerade/onboardade`} testId="kpi-prospects" />
        <KpiBlock
          label="Rekryteringsmål"
          value={target > 0 ? `${kpis.signed_or_onboarded}/${target}` : "Ej satt"}
          sub={target > 0 ? `${pct}% · ${status === "behind" ? "ligger efter" : status === "on_track" ? "i fas" : ""}` : "Sätt mål nedan"}
          tone={target > 0 ? status : "neutral"}
          testId="kpi-goal"
        />
      </section>

      {/* Performance from kontorslistan */}
      {office.kategori && (
        <section className="card-surface p-6" data-testid="performance-section">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <div>
              <div className="overline">Kontorslistan</div>
              <h2 className="font-display font-extrabold tracking-tight text-xl mt-1 flex items-center gap-2">
                <ChartLineUp size={18} color="#CBA135" weight="duotone" /> Prestanda
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <KategoriPill kategori={office.kategori} size="lg" />
              {office.prio && (
                <span className="text-[11px] uppercase tracking-wider font-display font-bold text-[#0A0A0A] bg-[#F4F4F5] px-2.5 py-1.5 rounded-full">
                  Prio {office.prio}
                </span>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="overline">Omsättning (period)</div>
              <div className="font-display font-extrabold tracking-tighter text-2xl mt-1">{formatSEK(office.oms)}</div>
              <div className="text-[12px] font-body mt-0.5" style={{ color: (office.yoy_pct ?? 0) >= 0 ? "#1E5B34" : "#9A2E22" }}>
                {formatPct(office.yoy_pct)} vs. föregående år
              </div>
            </div>
            <div>
              <div className="overline">Omsättning ifjol</div>
              <div className="font-display font-extrabold tracking-tighter text-2xl mt-1">{formatSEK(office.oms_fjol)}</div>
            </div>
            <div>
              <div className="overline">Sålda objekt</div>
              <div className="font-display font-extrabold tracking-tighter text-2xl mt-1">{office.sald}</div>
              <div className="text-[12px] text-[#52525B] font-body mt-0.5">{office.sald_fjol} ifjol</div>
            </div>
            <div>
              <div className="overline">Kommentar</div>
              <div className="text-[13px] font-body mt-1.5">{office.kommentar || "—"}</div>
            </div>
          </div>
          {office.recommended_action && (
            <div className="mt-5 pt-4 border-t border-[#E5E5E5]">
              <div className="overline flex items-center gap-1.5 text-[#9A2E22]">
                <Warning size={12} weight="bold" /> Prio 1 — rekommenderad åtgärd
              </div>
              <p className="text-[13px] font-body mt-1.5 text-[#0A0A0A] leading-relaxed">{office.recommended_action}</p>
            </div>
          )}
        </section>
      )}

      {/* Recruitment goal editor */}
      <section className="card-surface p-6" data-testid="recruitment-section">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="overline">Steg 7 — Rekrytering</div>
            <h2 className="font-display font-extrabold tracking-tight text-xl mt-1 flex items-center gap-2">
              <Target size={18} color="#CBA135" weight="duotone" /> Mål för {office.name}
            </h2>
          </div>
          <button
            data-testid="save-goal-btn"
            onClick={saveGoal}
            disabled={saving}
            className="btn-primary inline-flex items-center gap-1.5"
          >
            <FloppyDisk size={14} /> {saving ? "Sparar…" : "Spara mål"}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <Label className="overline">Antal nya mäklare (mål)</Label>
            <Input
              type="number"
              min="0"
              data-testid="target-hires-input"
              className="input-base mt-1.5 text-2xl font-display font-bold tabular-nums"
              value={goalForm.target_hires}
              onChange={(e) => setGoalForm({ ...goalForm, target_hires: e.target.value })}
            />
            {target > 0 && (
              <div className="mt-2">
                <div className="h-2 bg-[#F4F4F5] rounded-full overflow-hidden">
                  <div
                    className="h-full"
                    style={{
                      width: `${pct}%`,
                      background: status === "behind" ? "#DC2626" : status === "on_track" ? "#22C55E" : "#CBA135",
                    }}
                  />
                </div>
                <div className="text-[11px] text-[#52525B] mt-1 font-body">
                  {kpis.signed_or_onboarded} av {target} klara ({pct}%)
                </div>
              </div>
            )}
          </div>
          <div>
            <Label className="overline">Deadline</Label>
            <Input
              type="date"
              data-testid="deadline-input"
              className="input-base mt-1.5"
              value={goalForm.deadline}
              onChange={(e) => setGoalForm({ ...goalForm, deadline: e.target.value })}
            />
            <div className="text-[11px] text-[#52525B] mt-1 font-body">
              {goalForm.deadline ? `Slut: ${formatDate(goalForm.deadline)}` : "Ingen deadline satt"}
            </div>
          </div>
          <div>
            <Label className="overline">Status-flagga</Label>
            <Textarea
              data-testid="status-note-input"
              className="input-base mt-1.5 font-body"
              rows={3}
              placeholder='t.ex. "Tappar Maria i augusti, behöver ersättare"'
              value={goalForm.status_note}
              onChange={(e) => setGoalForm({ ...goalForm, status_note: e.target.value })}
            />
          </div>
        </div>

        <div className="mt-6">
          <Label className="overline">Specifika behov / kravprofiler</Label>
          <div className="mt-2 flex gap-2">
            <Input
              data-testid="new-need-input"
              className="input-base flex-1"
              placeholder='t.ex. "BR-specialist", "Erfaren mäklare 5+ år"'
              value={newNeed}
              onChange={(e) => setNewNeed(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addNeed();
                }
              }}
            />
            <button onClick={addNeed} className="btn-secondary inline-flex items-center gap-1.5">
              <Plus size={14} /> Lägg till
            </button>
          </div>
          {goalForm.needs.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {goalForm.needs.map((n, i) => (
                <span
                  key={i}
                  data-testid={`need-tag-${i}`}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#FAF3E1] text-[#7C5A0F] text-[12px] font-display font-semibold"
                >
                  {n}
                  <button onClick={() => removeNeed(i)} className="hover:text-[#DC2626]">
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {goal?.updated_by_name && (
          <p className="text-[11px] text-[#A1A1AA] mt-4 font-display font-semibold uppercase tracking-wider">
            Senast uppdaterat {formatDateTime(goal.updated_at)} av {goal.updated_by_name}
          </p>
        )}
      </section>

      {/* Prospects in city */}
      <section>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div>
            <div className="overline">Värvning</div>
            <h2 className="font-display font-extrabold tracking-tight text-2xl mt-1">
              Prospekt i {office.city}
            </h2>
          </div>
          <div className="flex gap-2 items-center">
            {(() => {
              const unlinked = prospects.filter((p) => !p.office_id).length;
              if (unlinked === 0) return null;
              return (
                <button
                  data-testid="link-city-prospects-btn"
                  onClick={linkCityProspects}
                  className="btn-secondary inline-flex items-center gap-1.5 text-xs"
                  title="Sätt office_id explicit på alla stadsmatchade prospekt"
                >
                  <LinkSimple size={12} weight="bold" /> Länka {unlinked} stadsmatchade
                </button>
              );
            })()}
            <Link to="/pipeline" className="btn-ghost inline-flex items-center gap-1 text-xs">
              Öppna pipeline →
            </Link>
          </div>
        </div>
        {prospects.length === 0 ? (
          <div className="card-surface p-8 text-center text-sm text-[#A1A1AA] font-body" data-testid="no-prospects">
            Inga prospekt i {office.city} ännu. Lägg till på pipeline-sidan.
          </div>
        ) : (
          <div className="card-surface overflow-hidden">
            <Table data-testid="office-prospects-table">
              <TableHeader>
                <TableRow className="bg-[#FAFAFA]">
                  <TableHead className="overline">Namn</TableHead>
                  <TableHead className="overline">Status</TableHead>
                  <TableHead className="overline">Koppling</TableHead>
                  <TableHead className="overline">Nuvarande kedja</TableHead>
                  <TableHead className="overline">Ansvarig</TableHead>
                  <TableHead className="overline">Nästa steg</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {prospects.map((p) => (
                  <TableRow key={p.id} className="row-hover">
                    <TableCell className="font-display font-bold text-[14px]">{p.name}</TableCell>
                    <TableCell><StatusPill status={p.status} /></TableCell>
                    <TableCell>
                      {p.office_id ? (
                        <span className="text-[11px] uppercase tracking-wider font-display font-bold text-[#16A34A] bg-[#DCFCE7] px-1.5 py-0.5 rounded">
                          ● Explicit
                        </span>
                      ) : (
                        <span className="text-[11px] uppercase tracking-wider font-display font-bold text-[#52525B] bg-[#F4F4F5] px-1.5 py-0.5 rounded">
                          Stadsmatch
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="font-body text-sm text-[#52525B]">{p.current_agency || "—"}</TableCell>
                    <TableCell className="font-body text-sm">{p.owner_name || <span className="text-[#A1A1AA]">Otilldelad</span>}</TableCell>
                    <TableCell className="font-body text-sm text-[#52525B]">
                      {p.next_step ? `${p.next_step} · ${formatDate(p.next_step_date)}` : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {/* Brokers */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <div className="overline">Människor</div>
            <h2 className="font-display font-extrabold tracking-tight text-2xl mt-1">
              Aktiva mäklare ({brokers.length})
            </h2>
          </div>
        </div>
        <div className="card-surface overflow-hidden">
          <Table data-testid="office-brokers-table">
            <TableHeader>
              <TableRow className="bg-[#FAFAFA]">
                <TableHead className="overline">Mäklare</TableHead>
                <TableHead className="overline">Roll</TableHead>
                <TableHead className="overline">Kontakt</TableHead>
                <TableHead className="overline w-20"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {brokers.map((b) => (
                <TableRow key={b.id} className="row-hover">
                  <TableCell className="py-3">
                    <div className="flex items-center gap-3">
                      <img src={b.avatar_url} alt="" className="w-9 h-9 rounded-full object-cover border border-[#E5E5E5]" onError={(e) => { e.target.style.display = "none"; }} />
                      <div>
                        <div className="font-display font-bold text-[13px]">{b.name}</div>
                        <div className="text-[11px] text-[#A1A1AA] font-body">{b.email}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-[13px] text-[#52525B] font-body">{b.title}</TableCell>
                  <TableCell className="text-[12px] text-[#52525B] font-body">{b.phone}</TableCell>
                  <TableCell>
                    {b.profile_url && (
                      <a href={b.profile_url} target="_blank" rel="noreferrer" className="btn-ghost p-1.5 inline-block">
                        <ArrowSquareOut size={12} />
                      </a>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {brokers.length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-center py-8 text-[#A1A1AA] text-sm">Inga mäklare hittade.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      {/* Timeline */}
      <section>
        <div className="overline">Tidslinje</div>
        <h2 className="font-display font-extrabold tracking-tight text-2xl mt-1 mb-3">
          Aktivitet kopplad till kontoret
        </h2>
        <div className="card-surface p-6">
          <ActivityFeed items={timeline} />
        </div>
      </section>
    </div>
  );
}

function KpiBlock({ label, value, sub, tone = "neutral", testId }) {
  const tones = {
    neutral: { border: "#E5E5E5", accent: "#0A0A0A" },
    on_track: { border: "#22C55E", accent: "#16A34A" },
    behind: { border: "#DC2626", accent: "#DC2626" },
    no_goal: { border: "#E5E5E5", accent: "#A1A1AA" },
  };
  const t = tones[tone] || tones.neutral;
  return (
    <div className="card-surface p-5 fade-up" style={{ borderColor: t.border }} data-testid={testId}>
      <div className="overline">{label}</div>
      <div className="mt-2 font-display font-extrabold tracking-tighter text-3xl" style={{ color: t.accent }}>
        {value}
      </div>
      {sub && <div className="text-[12px] text-[#52525B] font-body mt-1">{sub}</div>}
    </div>
  );
}
