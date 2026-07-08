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
  Clock,
  XCircle,
  Lightning,
  Warning,
  CheckCircle,
} from "@phosphor-icons/react";
import { api, formatNumber, PIPELINE_STATUSES, STATUS_TONE, daysSince } from "../lib/api";
import KpiCard from "../components/KpiCard";
import ActivityFeed from "../components/ActivityFeed";

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [insights, setInsights] = useState(null);
  const [officeGoals, setOfficeGoals] = useState(null);

  const load = async () => {
    const [k, i, og] = await Promise.all([
      api.get("/dashboard/kpis"),
      api.get("/dashboard/insights"),
      api.get("/dashboard/office-recruitment"),
    ]);
    setData(k.data);
    setInsights(i.data);
    setOfficeGoals(og.data);
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
          testId="kpi-pipeline"
          label="Värvningsprospekt"
          value={data.prospects_total}
          sub={`${totalInPipeline} aktiva i pipeline`}
          accent
        />
        <KpiCard
          testId="kpi-pipeline-value"
          label="Pipeline-värde (SEK)"
          value={
            data.pipeline_value
              ? new Intl.NumberFormat("sv-SE", {
                  notation: "compact",
                  maximumFractionDigits: 1,
                }).format(data.pipeline_value)
              : "0"
          }
          sub="Förv. intäkt år 1 + signing bonus"
        />
        <KpiCard
          testId="kpi-stale"
          label={`Fastnat (>${data.stale_days || 14} dgr)`}
          value={data.stale_count || 0}
          sub={
            (data.stale_count || 0) > 0
              ? "Kräver uppföljning"
              : "Allt rör sig framåt"
          }
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

      {/* Kontorsprestanda från kontorslistan */}
      {data.office_performance && (
        <section className="card-surface p-6 fade-up delay-2" data-testid="office-performance-section">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <div>
              <div className="overline">Kontorslistan</div>
              <h2 className="font-display font-extrabold tracking-tight text-xl mt-1 flex items-center gap-2">
                <Warning size={18} color="#C94C3F" weight="duotone" /> Kontorsprestanda
              </h2>
            </div>
            <Link
              to="/akutlista"
              data-testid="open-akutlista-link"
              className="btn-secondary inline-flex items-center gap-1.5 text-xs"
            >
              Öppna akutlistan <ArrowUpRight size={12} />
            </Link>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="rounded-lg p-4" style={{ background: "#FDEDEB" }}>
              <div className="overline" style={{ color: "#9A2E22" }}>Problem</div>
              <div className="font-display font-extrabold tracking-tighter text-3xl mt-1" style={{ color: "#9A2E22" }}>
                {data.office_performance.kategori?.PROBLEM || 0}
              </div>
              <div className="text-[12px] font-body mt-0.5" style={{ color: "#9A2E22" }}>
                varav {data.office_performance.prio1_count} Prio 1
              </div>
            </div>
            <div className="rounded-lg p-4" style={{ background: "#FBF1DC" }}>
              <div className="overline" style={{ color: "#7C5A0F" }}>Utmaningar</div>
              <div className="font-display font-extrabold tracking-tighter text-3xl mt-1" style={{ color: "#7C5A0F" }}>
                {data.office_performance.kategori?.UTMANINGAR || 0}
              </div>
            </div>
            <div className="rounded-lg p-4" style={{ background: "#E6F4EA" }}>
              <div className="overline" style={{ color: "#1E5B34" }}>OK / Kör</div>
              <div className="font-display font-extrabold tracking-tighter text-3xl mt-1" style={{ color: "#1E5B34" }}>
                {data.office_performance.kategori?.OK || 0}
              </div>
            </div>
            <div>
              <div className="overline">Total omsättning</div>
              <div className="font-display font-extrabold tracking-tighter text-3xl mt-1">
                {new Intl.NumberFormat("sv-SE", { notation: "compact", maximumFractionDigits: 1 }).format(data.office_performance.total_oms || 0)}
              </div>
              <div
                className="text-[12px] font-body mt-0.5"
                style={{ color: (data.office_performance.total_oms_yoy_pct ?? 0) >= 0 ? "#1E5B34" : "#9A2E22" }}
              >
                {data.office_performance.total_oms_yoy_pct != null
                  ? `${data.office_performance.total_oms_yoy_pct >= 0 ? "+" : ""}${data.office_performance.total_oms_yoy_pct}% YoY`
                  : "—"}
              </div>
            </div>
          </div>
        </section>
      )}

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

      {/* Insights — sources + lost-to + stale */}
      {insights && (
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="card-surface p-6 fade-up" data-testid="insights-sources">
            <div className="overline mb-1">Källfördelning</div>
            <h2 className="font-display font-extrabold tracking-tight text-xl mb-4 flex items-center gap-2">
              <Lightning size={18} color="#CBA135" weight="duotone" /> Varifrån kommer leadsen?
            </h2>
            {insights.sources?.length ? (
              <div className="flex flex-col gap-2.5">
                {insights.sources.map((s) => {
                  const max = Math.max(...insights.sources.map((x) => x.count), 1);
                  const pct = (s.count / max) * 100;
                  return (
                    <div key={s.source} className="flex items-center gap-3">
                      <div className="w-32 text-[12px] font-display font-semibold text-[#0A0A0A] truncate">
                        {s.source}
                      </div>
                      <div className="flex-1 h-1.5 bg-[#F4F4F5] rounded-full overflow-hidden">
                        <div className="h-full bg-[#CBA135]" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="w-8 text-right font-display font-bold tabular-nums text-sm">
                        {s.count}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-sm text-[#A1A1AA] py-4 font-body">
                Lägg till källa när du skapar prospekt så syns fördelningen här.
              </div>
            )}
          </div>

          <div className="card-surface p-6 fade-up delay-1" data-testid="insights-lost">
            <div className="flex items-center justify-between mb-1">
              <div className="overline">Konkurrentintelligens</div>
              <Link to="/lost" className="text-[11px] font-display font-bold text-[#52525B] hover:text-[#CBA135] inline-flex items-center gap-0.5">
                Visa alla <ArrowUpRight size={11} />
              </Link>
            </div>
            <h2 className="font-display font-extrabold tracking-tight text-xl mb-4 flex items-center gap-2">
              <XCircle size={18} color="#DC2626" weight="duotone" /> Förlorade till
            </h2>
            {insights.lost_breakdown?.length ? (
              <div className="flex flex-col gap-2.5">
                {insights.lost_breakdown.slice(0, 6).map((l) => {
                  const max = Math.max(...insights.lost_breakdown.map((x) => x.count), 1);
                  const pct = (l.count / max) * 100;
                  return (
                    <div key={l.agency} className="flex items-center gap-3">
                      <div className="w-32 text-[12px] font-display font-semibold text-[#0A0A0A] truncate">
                        {l.agency}
                      </div>
                      <div className="flex-1 h-1.5 bg-[#F4F4F5] rounded-full overflow-hidden">
                        <div className="h-full bg-[#DC2626]" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="w-8 text-right font-display font-bold tabular-nums text-sm">
                        {l.count}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-sm text-[#A1A1AA] py-4 font-body">
                Inga förlorade prospekt än. Bra jobbat.
              </div>
            )}
          </div>

          <div className="card-surface p-6 fade-up delay-2" data-testid="insights-stale">
            <div className="overline mb-1">Stale-alerts</div>
            <h2 className="font-display font-extrabold tracking-tight text-xl mb-4 flex items-center gap-2">
              <Clock size={18} color="#F59E0B" weight="duotone" />
              Fastnat &gt;{insights.stale_days} dgr
            </h2>
            {insights.top_stale?.length ? (
              <ul className="flex flex-col divide-y divide-[#E5E5E5]">
                {insights.top_stale.map((p) => {
                  const d = daysSince(p.updated_at);
                  return (
                    <li key={p.id} className="py-2.5 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-display font-bold text-[13px] text-[#0A0A0A] truncate">{p.name}</div>
                        <div className="text-[11px] text-[#52525B] font-body truncate">
                          {p.status} · {p.owner_name || "Otilldelad"}
                        </div>
                      </div>
                      <span
                        className="text-[11px] font-display font-bold uppercase tracking-wider px-1.5 py-0.5 rounded whitespace-nowrap"
                        style={{
                          background: d >= 30 ? "#FEF2F2" : "#FEF3C7",
                          color: d >= 30 ? "#7F1D1D" : "#7C2D12",
                        }}
                      >
                        {d}d
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="text-sm text-[#A1A1AA] py-4 font-body">
                Inga fastnat just nu. Skickligt jobbat.
              </div>
            )}
            <Link
              to="/pipeline"
              className="mt-4 inline-flex items-center gap-1 text-[12px] font-display font-bold text-[#CBA135]"
            >
              Öppna pipeline <ArrowUpRight size={11} />
            </Link>
          </div>
        </section>
      )}

      {/* Office recruitment rollup */}
      {officeGoals && officeGoals.totals.with_goal > 0 && (
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6" data-testid="office-recruitment-rollup">
          <div className="card-surface p-6 fade-up lg:col-span-2">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="overline">Rekrytering per kontor</div>
                <h2 className="font-display font-extrabold tracking-tight text-xl mt-1 flex items-center gap-2">
                  <Buildings size={18} color="#CBA135" weight="duotone" />
                  Mål vs utfall · {officeGoals.totals.with_goal} kontor med mål
                </h2>
              </div>
              <Link to="/offices" className="btn-ghost inline-flex items-center gap-1 text-xs">
                Alla kontor <ArrowUpRight size={11} />
              </Link>
            </div>

            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="text-center p-3 rounded-md bg-[#DCFCE7]">
                <div className="text-[10px] uppercase tracking-wider font-display font-bold text-[#14532D]">I fas</div>
                <div className="font-display font-extrabold text-2xl tabular-nums text-[#16A34A] mt-1">{officeGoals.totals.on_track}</div>
              </div>
              <div className="text-center p-3 rounded-md bg-[#FEF2F2]">
                <div className="text-[10px] uppercase tracking-wider font-display font-bold text-[#7F1D1D]">Efter mål</div>
                <div className="font-display font-extrabold text-2xl tabular-nums text-[#DC2626] mt-1">{officeGoals.totals.behind}</div>
              </div>
              <div className="text-center p-3 rounded-md bg-[#FAF3E1]">
                <div className="text-[10px] uppercase tracking-wider font-display font-bold text-[#7C5A0F]">Totalt mål</div>
                <div className="font-display font-extrabold text-2xl tabular-nums text-[#CBA135] mt-1">{officeGoals.totals.total_signed}/{officeGoals.totals.total_target}</div>
              </div>
            </div>

            <ul className="flex flex-col divide-y divide-[#E5E5E5]">
              {officeGoals.rows.filter((r) => r.target_hires > 0).slice(0, 6).map((r) => {
                const pct = r.target_hires > 0 ? Math.min(100, Math.round((r.current_hires / r.target_hires) * 100)) : 0;
                const color = r.status === "behind" ? "#DC2626" : "#22C55E";
                return (
                  <li
                    key={r.office_id}
                    data-testid={`rollup-row-${r.office_id}`}
                    className="py-2.5"
                  >
                    <Link to={`/offices/${r.office_id}`} className="flex items-center gap-3 group">
                      {r.status === "behind" ? (
                        <Warning size={14} color="#DC2626" weight="duotone" />
                      ) : (
                        <CheckCircle size={14} color="#22C55E" weight="duotone" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-display font-bold text-[13px] truncate group-hover:text-[#CBA135]">{r.office_name}</div>
                        <div className="text-[11px] text-[#52525B] font-body">
                          {r.city}{r.deadline ? ` · deadline ${r.deadline.slice(0, 10)}` : ""}
                        </div>
                      </div>
                      <div className="flex-1 max-w-[160px] hidden sm:block">
                        <div className="h-1.5 bg-[#F4F4F5] rounded-full overflow-hidden">
                          <div className="h-full" style={{ width: `${pct}%`, background: color }} />
                        </div>
                      </div>
                      <div className="text-right font-display font-extrabold tabular-nums text-sm w-12">
                        {r.current_hires}/{r.target_hires}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="card-surface p-6 fade-up delay-1">
            <div className="overline mb-1">Öppna behov</div>
            <h2 className="font-display font-extrabold tracking-tight text-xl mb-4 flex items-center gap-2">
              <Target size={18} color="#CBA135" weight="duotone" />
              {officeGoals.totals.open_needs} behov flaggade
            </h2>
            {officeGoals.open_needs.length === 0 ? (
              <p className="text-sm text-[#A1A1AA] font-body">
                Inga specifika behov flaggade från kontorscheferna.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {officeGoals.open_needs.slice(0, 8).map((n, i) => (
                  <li key={i} className="text-[13px] font-body">
                    <span className="font-display font-bold text-[#0A0A0A]">{n.office_name}:</span>{" "}
                    <span className="text-[#52525B]">{n.need}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
