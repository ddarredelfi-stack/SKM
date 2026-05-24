import { useEffect, useState } from "react";
import { Plus, Target, Trash, FloppyDisk, EnvelopeSimple } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, formatDate } from "../lib/api";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

export default function Settings() {
  const [goals, setGoals] = useState([]);
  const [dueReminders, setDueReminders] = useState([]);
  const [newGoal, setNewGoal] = useState({ title: "", target: 5, current: 0, metric: "", deadline: "" });

  const load = async () => {
    const [g, d] = await Promise.all([
      api.get("/goals"),
      api.get("/reminders/due", { params: { days_ahead: 14 } }),
    ]);
    setGoals(g.data.items || []);
    setDueReminders(d.data.items || []);
  };
  useEffect(() => { load(); }, []);

  const updateField = async (id, field, value) => {
    try {
      await api.patch(`/goals/${id}`, { [field]: value });
      load();
    } catch (e) {
      toast.error("Fel: " + e.message);
    }
  };

  const create = async () => {
    if (!newGoal.title.trim()) { toast.error("Titel krävs"); return; }
    try {
      await api.post("/goals", {
        title: newGoal.title,
        target: Number(newGoal.target) || 1,
        current: Number(newGoal.current) || 0,
        metric: newGoal.metric,
        deadline: newGoal.deadline || null,
      });
      setNewGoal({ title: "", target: 5, current: 0, metric: "", deadline: "" });
      toast.success("Mål skapat");
      load();
    } catch (e) {
      toast.error("Fel: " + e.message);
    }
  };

  const remove = async (id) => {
    if (!confirm("Ta bort mål?")) return;
    await api.delete(`/goals/${id}`);
    load();
  };

  const sendReminder = async (pid) => {
    const res = await api.post("/reminders/send", { prospect_id: pid });
    if (res.data.status === "success") toast.success(res.data.message);
    else if (res.data.status === "skipped") toast.warning(res.data.message);
    else toast.error(res.data.message);
  };

  return (
    <div data-testid="settings-page" className="flex flex-col gap-8">
      <header>
        <div className="overline">Konfiguration</div>
        <h1 className="font-display font-extrabold tracking-tighter text-4xl mt-1">
          Mål & Inställningar
        </h1>
      </header>

      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="overline">Etableringsmål</div>
            <h2 className="font-display font-extrabold tracking-tight text-2xl mt-1 flex items-center gap-2">
              <Target size={20} color="#CBA135" weight="duotone" /> Mål vs utfall
            </h2>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          {goals.map((g) => {
            const pct = Math.min(100, Math.round((g.current / Math.max(g.target, 1)) * 100));
            return (
              <div key={g.id} className="card-surface p-5" data-testid={`goal-card-${g.id}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <Input
                      defaultValue={g.title}
                      onBlur={(e) => e.target.value !== g.title && updateField(g.id, "title", e.target.value)}
                      className="input-base font-display font-bold text-[14px] !p-2"
                    />
                  </div>
                  <button onClick={() => remove(g.id)} className="btn-ghost p-1.5 text-[#DC2626]">
                    <Trash size={14} />
                  </button>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <div className="flex-1">
                    <div className="text-[11px] text-[#A1A1AA] uppercase tracking-wider font-display font-bold">Aktuellt</div>
                    <Input
                      type="number"
                      defaultValue={g.current}
                      onBlur={(e) => Number(e.target.value) !== g.current && updateField(g.id, "current", Number(e.target.value))}
                      className="input-base mt-1 !p-2 font-display font-bold text-xl"
                    />
                  </div>
                  <div className="flex-1">
                    <div className="text-[11px] text-[#A1A1AA] uppercase tracking-wider font-display font-bold">Mål</div>
                    <Input
                      type="number"
                      defaultValue={g.target}
                      onBlur={(e) => Number(e.target.value) !== g.target && updateField(g.id, "target", Number(e.target.value))}
                      className="input-base mt-1 !p-2 font-display font-bold text-xl"
                    />
                  </div>
                </div>
                <div className="mt-3 h-2 bg-[#F4F4F5] rounded-full overflow-hidden">
                  <div className="h-full bg-[#CBA135]" style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-2 flex justify-between text-[12px] font-body text-[#52525B]">
                  <span>{g.metric || "—"}</span>
                  <span>Deadline {formatDate(g.deadline)}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="card-surface p-5">
          <div className="overline mb-3">Nytt mål</div>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <Input
              data-testid="new-goal-title"
              placeholder="Titel (t.ex. 5 nya kontor Q2)"
              className="input-base md:col-span-2"
              value={newGoal.title}
              onChange={(e) => setNewGoal({ ...newGoal, title: e.target.value })}
            />
            <Input
              type="number"
              placeholder="Mål"
              className="input-base"
              value={newGoal.target}
              onChange={(e) => setNewGoal({ ...newGoal, target: e.target.value })}
            />
            <Input
              type="number"
              placeholder="Nuvarande"
              className="input-base"
              value={newGoal.current}
              onChange={(e) => setNewGoal({ ...newGoal, current: e.target.value })}
            />
            <Input
              type="date"
              className="input-base"
              value={newGoal.deadline}
              onChange={(e) => setNewGoal({ ...newGoal, deadline: e.target.value })}
            />
            <Input
              placeholder="Mätetal"
              className="input-base md:col-span-2"
              value={newGoal.metric}
              onChange={(e) => setNewGoal({ ...newGoal, metric: e.target.value })}
            />
            <button
              data-testid="create-goal-btn"
              onClick={create}
              className="btn-primary inline-flex items-center gap-1.5 md:col-span-3"
            >
              <Plus size={14} /> Lägg till mål
            </button>
          </div>
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="overline">Påminnelser</div>
            <h2 className="font-display font-extrabold tracking-tight text-2xl mt-1 flex items-center gap-2">
              <EnvelopeSimple size={20} color="#CBA135" weight="duotone" /> Nästa 14 dagar
            </h2>
          </div>
        </div>
        {dueReminders.length === 0 ? (
          <div className="card-surface p-8 text-center text-sm text-[#A1A1AA] font-body">
            Inga uppföljningar planerade.
          </div>
        ) : (
          <div className="card-surface divide-y divide-[#E5E5E5]">
            {dueReminders.map((p) => (
              <div key={p.id} className="p-4 flex items-center justify-between gap-4" data-testid={`due-${p.id}`}>
                <div>
                  <div className="font-display font-bold text-[14px]">{p.name}</div>
                  <div className="text-[12px] text-[#52525B] font-body">
                    {p.next_step || "Uppföljning"} · {p.city || "—"}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-[12px] font-display font-bold text-[#CBA135]">
                    {formatDate(p.next_step_date)}
                  </div>
                  <button
                    onClick={() => sendReminder(p.id)}
                    className="btn-secondary inline-flex items-center gap-1 text-[12px]"
                  >
                    <EnvelopeSimple size={12} /> Skicka mejl
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card-surface p-6">
        <div className="overline mb-2">Integrationer</div>
        <ul className="text-sm font-body space-y-2 text-[#52525B]">
          <li><strong className="text-[#0A0A0A] font-display">AI research:</strong> Emergent LLM key (Claude Sonnet 4.5) — aktiv.</li>
          <li><strong className="text-[#0A0A0A] font-display">E-postpåminnelser:</strong> Resend — kräver <code className="bg-[#F4F4F5] px-1.5 py-0.5 rounded font-mono">RESEND_API_KEY</code> och <code className="bg-[#F4F4F5] px-1.5 py-0.5 rounded font-mono">REMINDER_RECIPIENT</code> i backend/.env.</li>
          <li><strong className="text-[#0A0A0A] font-display">Karttiles:</strong> CartoDB Positron (ingen API-nyckel).</li>
          <li><strong className="text-[#0A0A0A] font-display">Scraping-källa:</strong> skandiamaklarna.se (live).</li>
        </ul>
      </section>
    </div>
  );
}
