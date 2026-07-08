import { KATEGORI_TONE } from "../lib/api";

const LABELS = {
  PROBLEM: "Problem",
  UTMANINGAR: "Utmaningar",
  OK: "OK/Kör",
};

export default function KategoriPill({ kategori, size = "sm", testId }) {
  if (!kategori) return <span className="text-[#A1A1AA] text-[12px]">—</span>;
  const tone = KATEGORI_TONE[kategori] || { bg: "#F4F4F5", fg: "#52525B", dot: "#A1A1AA" };
  const padding = size === "lg" ? "px-3 py-1.5 text-[12px]" : "px-2 py-1 text-[11px]";
  return (
    <span
      data-testid={testId || `kategori-pill-${kategori}`}
      className={`inline-flex items-center gap-1.5 rounded-full font-display font-semibold ${padding}`}
      style={{ background: tone.bg, color: tone.fg }}
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: tone.dot }} />
      {LABELS[kategori] || kategori}
    </span>
  );
}
