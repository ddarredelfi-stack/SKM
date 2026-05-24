import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  ArrowsClockwise,
  Buildings,
  UsersThree,
  Briefcase,
  Target,
  Compass,
} from "@phosphor-icons/react";
import { api, formatNumber, PIPELINE_STATUSES, STATUS_TONE } from "../lib/api";
import KpiCard from "../components/KpiCard";
import ActivityFeed from "../components/ActivityFeed";

export default function Dashboard() {
  const [data, setData] = useState(null);

  const load = async () => {
    const res = await api.get("/dashboard/kpis");
    setData(res.data);
  };

  useEffect(() => {
    load();
  }, []);

  if (!data) {
    return <div className="text-sm text-[#52525B]" data-testid="dashboard-loading">Laddar dashboard…</div>;
  }

  const pipelineEntries = PIPELINE_STATUSES.map((s) => [s, data.pipeline[s] || 0]);
  const totalInPipeline = pipelineEntries.reduce((sum, [, c]) => sum + c, 0);

  return (
    <div data-testid="dashboard-page" className="flex flex-col gap-8">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <div className="overline">Översikt</div>
          <h1 className="font-display font-extrabold tracking-tighter text-[#0A0A0A] text-4xl sm:text-5xl mt-1">
            God morgon, Delfi.
          </h1>
          <p className="text-[#52525B] text-sm md:text-base font-body mt-2 max-w-xl">
            Hela rikstäckningen av Skandiamäklarna och din värvnings-pipeline på en sida.
            Senast uppdaterad {new Date(data.as_of).toLocaleString("sv-SE")}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            data-testid="header-refresh-btn"
            onClick={load}
            className="btn-ghost inline-flex items-center gap-1.5"
          >
            <ArrowsClockwise size={14} /> Uppdatera
          </button>
          <Link
            to="/scrape"
            data-testid="header-scrape-link"
            className="btn-primary inline-flex items-center gap-1.5"
          >
            <Compass size={14} weight="duotone" />
            Scraping
          </Link>
        </div>
      </header>

      {/* KPI row */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          testId="kpi-offices"
          label="Kontor i kedjan"
          value={data.offices}
          sub={`${data.regions_covered} regioner med närvaro`}
        />
        <KpiCard
          testId="kpi-brokers"
          label="Aktiva mäklare"
          value={data.brokers}
          sub={`${(data.brokers / Math.max(data.offices, 1)).toFixed(1)} mäklare/kontor i snitt`}
        />
        <KpiCard
          testId="kpi-listings"
          label="Aktiva objekt"
          value={data.listings}
          sub={data.listings ? "Live från databasen" : "Ej synkat — finns ej i live-scrape än"}
        />
        <KpiCard
          testId="kpi-pipeline"
          label="Värvningsprospekt"
          value={data.prospects_total}
          sub={`${totalInPipeline} i pipeline`}
          accent
        />
      </section>

      {/* Pipeline mini + goals */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="card-surface p-6 lg:col-span-2 fade-up delay-1">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="overline">Pipeline</div>
              <h2 className="font-display font-extrabold tracking-tight text-xl mt-1">
                Värvningstratt
              </h2>
            </div>
            <Link
              to="/pipeline"
              data-testid="open-pipeline-link"
              className="btn-ghost inline-flex items-center gap-1 text-xs"
            >
              Öppna kanban <ArrowUpRight size={12} />
            </Link>
          </div>
          <div className="flex flex-col gap-3">
            {pipelineEntries.map(([status, count]) => {
              const tone = STATUS_TONE[status];
              const max = Math.max(...pipelineEntries.map(([, c]) => c), 1);
              const pct = (count / max) * 100;
              return (
                <div
                  key={status}
                  data-testid={`pipeline-row-${status}`}
                  className="flex items-center gap-3"
                >
                  <div className="w-28 text-[12px] font-display font-semibold text-[#0A0A0A]">
                    {status}
                  </div>
                  <div className="flex-1 h-2 bg-[#F4F4F5] rounded-full overflow-hidden">
                    <div
                      className="h-full"
                      style={{ width: `${pct}%`, background: tone.dot }}
                    />
                  </div>
                  <div className="w-8 text-right font-display font-bold tabular-nums text-sm">
                    {count}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card-surface p-6 fade-up delay-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="overline">Mål Q1–Q4 2026</div>
              <h2 className="font-display font-extrabold tracking-tight text-xl mt-1 flex items-center gap-2">
                <Target size={18} color="#CBA135" weight="duotone" /> Status
              </h2>
            </div>
          </div>
          <div className="flex flex-col gap-4">
            {data.goals?.map((g) => {
              const pct = Math.min(100, Math.round((g.current / Math.max(g.target, 1)) * 100));
              return (
                <div key={g.id} data-testid={`goal-${g.id}`}>
                  <div className="flex justify-between items-baseline">
                    <div className="font-display font-bold text-[13px] text-[#0A0A0A]">{g.title}</div>
                    <div className="text-[11px] font-display font-semibold text-[#52525B] tabular-nums">
                      {g.current}/{g.target}
                    </div>
                  </div>
                  <div className="mt-1.5 h-1.5 bg-[#F4F4F5] rounded-full overflow-hidden">
                    <div
                      className="h-full"
                      style={{ width: `${pct}%`, background: "#CBA135" }}
                    />
                  </div>
                  <div className="text-[11px] text-[#A1A1AA] mt-1 font-body">
                    Deadline {g.deadline || "—"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Activity + Quick nav */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="card-surface p-6 lg:col-span-2 fade-up delay-3">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="overline">Aktivitet</div>
              <h2 className="font-display font-extrabold tracking-tight text-xl mt-1">
                Senaste händelser
              </h2>
            </div>
          </div>
          <ActivityFeed items={data.activity} />
        </div>

        <div className="flex flex-col gap-4 fade-up delay-4">
          <Link
            to="/map"
            data-testid="quick-link-map"
            className="card-surface p-5 hover:-translate-y-1 transition-transform group"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="overline">Geografisk täckning</div>
                <div className="font-display font-extrabold text-xl mt-1">
                  Karta & White Spots
                </div>
                <div className="text-xs text-[#52525B] mt-2 font-body">
                  Se kommuner utan Skandia-kontor.
                </div>
              </div>
              <ArrowUpRight size={20} className="text-[#A1A1AA] group-hover:text-[#CBA135]" />
            </div>
          </Link>
          <Link
            to="/brokers"
            data-testid="quick-link-brokers"
            className="card-surface p-5 hover:-translate-y-1 transition-transform group"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="overline">Människor</div>
                <div className="font-display font-extrabold text-xl mt-1">
                  Mäklarregister
                </div>
                <div className="text-xs text-[#52525B] mt-2 font-body">
                  Sök bland alla {formatNumber(data.brokers)} mäklare.
                </div>
              </div>
              <UsersThree size={20} weight="duotone" className="text-[#A1A1AA] group-hover:text-[#CBA135]" />
            </div>
          </Link>
          <Link
            to="/offices"
            data-testid="quick-link-offices"
            className="card-surface p-5 hover:-translate-y-1 transition-transform group"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="overline">Närvaro</div>
                <div className="font-display font-extrabold text-xl mt-1">
                  Kontor
                </div>
                <div className="text-xs text-[#52525B] mt-2 font-body">
                  Alla {formatNumber(data.offices)} kontor i kedjan.
                </div>
              </div>
              <Buildings size={20} weight="duotone" className="text-[#A1A1AA] group-hover:text-[#CBA135]" />
            </div>
          </Link>
        </div>
      </section>
    </div>
  );
}
