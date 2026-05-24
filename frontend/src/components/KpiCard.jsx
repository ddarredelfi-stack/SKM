import { TrendUp, TrendDown } from "@phosphor-icons/react";
import { formatNumber } from "../lib/api";

export default function KpiCard({ label, value, sub, delta, accent = false, testId }) {
  return (
    <div
      data-testid={testId || "kpi-card"}
      className="card-surface p-6 flex flex-col gap-1 fade-up"
      style={accent ? { borderColor: "#0A0A0A" } : {}}
    >
      <div className="overline">{label}</div>
      <div className="mt-2 flex items-baseline gap-3">
        <div className="font-display font-extrabold tracking-tighter text-[#0A0A0A] text-4xl">
          {typeof value === "number" ? formatNumber(value) : value}
        </div>
        {typeof delta === "number" && (
          <div
            className={`flex items-center gap-1 text-xs font-display font-semibold ${
              delta >= 0 ? "text-[#16A34A]" : "text-[#DC2626]"
            }`}
          >
            {delta >= 0 ? <TrendUp size={13} /> : <TrendDown size={13} />}
            {Math.abs(delta)}%
          </div>
        )}
      </div>
      {sub && (
        <div className="text-[12px] text-[#52525B] mt-1 font-body">{sub}</div>
      )}
    </div>
  );
}
