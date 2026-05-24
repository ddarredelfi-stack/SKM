import { useEffect, useState } from "react";
import { ArrowsClockwise, WarningCircle, CheckCircle, ShieldWarning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, formatDateTime } from "../lib/api";

const STATUS_BADGE = {
  ok: { fg: "#14532D", bg: "#DCFCE7", label: "OK", Icon: CheckCircle },
  blocked: { fg: "#7C2D12", bg: "#FED7AA", label: "Blockerad", Icon: ShieldWarning },
  no_data: { fg: "#713F12", bg: "#FEF08A", label: "Ingen data", Icon: WarningCircle },
  error: { fg: "#7F1D1D", bg: "#FECACA", label: "Fel", Icon: WarningCircle },
};

export default function Scrape() {
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState(null);
  const [discovered, setDiscovered] = useState([]);
  const [limit, setLimit] = useState(5);

  const loadStatus = async () => {
    const [s, d] = await Promise.all([
      api.get("/scrape/status"),
      api.get("/scrape/discovered"),
    ]);
    setLastRun(s.data.last);
    setDiscovered(d.data.items || []);
  };

  useEffect(() => { loadStatus(); }, []);

  const runScrape = async () => {
    setRunning(true);
    try {
      const res = await api.post(`/scrape/run?limit=${limit}`);
      if (res.data.status === "ok") {
        toast.success(`Skrapade ${res.data.offices_parsed}/${res.data.offices_found} kontor`);
      } else if (res.data.status === "blocked") {
        toast.warning("Sajten svarade inte (möjlig bot-blockering).");
      } else if (res.data.status === "no_data") {
        toast.warning("Inga kontor hittades på indexsidan.");
      } else {
        toast.error(res.data.errors?.[0] || "Scrape misslyckades");
      }
      loadStatus();
    } catch (e) {
      toast.error("Fel: " + e.message);
    } finally {
      setRunning(false);
    }
  };

  const badge = lastRun ? STATUS_BADGE[lastRun.status] || STATUS_BADGE.error : null;

  return (
    <div data-testid="scrape-page" className="flex flex-col gap-6">
      <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <div className="overline">Datakälla</div>
          <h1 className="font-display font-extrabold tracking-tighter text-4xl mt-1">
            Live-scraping
          </h1>
          <p className="text-[#52525B] text-sm mt-2 font-body max-w-2xl">
            Hämtar kontor och mäklare direkt från skandiamaklarna.se. Använd sparsamt –
            sajten kan blockera bots.
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <select
            data-testid="scrape-limit"
            className="input-base"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          >
            <option value={3}>3 kontor</option>
            <option value={5}>5 kontor</option>
            <option value={10}>10 kontor</option>
            <option value={20}>20 kontor</option>
          </select>
          <button
            data-testid="run-scrape-btn"
            onClick={runScrape}
            disabled={running}
            className="btn-primary inline-flex items-center gap-1.5"
          >
            <ArrowsClockwise size={14} className={running ? "animate-spin" : ""} />
            {running ? "Skrapar…" : "Kör scrape nu"}
          </button>
        </div>
      </header>

      <section className="card-surface p-6">
        <div className="overline mb-2">Senaste körning</div>
        {!lastRun && <div className="text-sm text-[#52525B] font-body">Ingen körning ännu.</div>}
        {lastRun && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-6">
            <div>
              <div className="text-[11px] text-[#A1A1AA] uppercase tracking-wider font-display font-bold">Status</div>
              <div className="mt-1.5 inline-flex items-center gap-1.5 px-2 py-1 rounded font-display font-bold text-[12px]"
                   style={{ background: badge.bg, color: badge.fg }}>
                <badge.Icon size={12} weight="duotone" /> {badge.label}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-[#A1A1AA] uppercase tracking-wider font-display font-bold">Hittade</div>
              <div className="font-display font-extrabold text-2xl tabular-nums">{lastRun.offices_found}</div>
            </div>
            <div>
              <div className="text-[11px] text-[#A1A1AA] uppercase tracking-wider font-display font-bold">Hämtade</div>
              <div className="font-display font-extrabold text-2xl tabular-nums">{lastRun.offices_parsed}</div>
            </div>
            <div>
              <div className="text-[11px] text-[#A1A1AA] uppercase tracking-wider font-display font-bold">Startad</div>
              <div className="text-sm font-body">{formatDateTime(lastRun.started_at)}</div>
            </div>
            <div>
              <div className="text-[11px] text-[#A1A1AA] uppercase tracking-wider font-display font-bold">Slutförd</div>
              <div className="text-sm font-body">{formatDateTime(lastRun.finished_at)}</div>
            </div>
          </div>
        )}
        {lastRun?.errors?.length > 0 && (
          <div className="mt-4 p-3 bg-[#FEF2F2] border border-[#FECACA] rounded text-[13px] text-[#7F1D1D] font-body">
            {lastRun.errors.join(" · ")}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <div className="overline">Live-fångst</div>
            <h2 className="font-display font-extrabold tracking-tight text-2xl mt-1">
              Senast skrapade kontor
            </h2>
          </div>
          <div className="text-xs text-[#52525B] font-body">{discovered.length} kontor</div>
        </div>
        {!discovered.length ? (
          <div className="card-surface p-8 text-center text-sm text-[#A1A1AA] font-body" data-testid="no-discovered">
            Inga kontor skrapade ännu. Kör en scrape för att hämta live-data.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {discovered.map((o, i) => (
              <div key={o.url} className="card-surface p-4" data-testid={`discovered-${i}`}>
                <div className="font-display font-extrabold text-[15px] text-[#0A0A0A] leading-tight">{o.name}</div>
                <div className="text-[12px] text-[#52525B] font-body mt-0.5">{o.city || "—"}</div>
                <div className="text-[12px] text-[#52525B] font-body mt-2">{o.address || "Adress saknas"}</div>
                <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#52525B] font-body">
                  {o.phone && <span>📞 {o.phone}</span>}
                  {o.email && <span>✉ {o.email}</span>}
                  <span>{o.brokers?.length || 0} mäklare hittade</span>
                </div>
                <a href={o.url} target="_blank" rel="noreferrer" className="text-[11px] text-[#CBA135] font-display font-bold mt-2 inline-block">
                  Öppna på skandiamaklarna.se →
                </a>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
