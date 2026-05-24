import { STATUS_TONE } from "../lib/api";

export default function StatusPill({ status, size = "sm", testId }) {
  const tone = STATUS_TONE[status] || STATUS_TONE.Identifierad;
  const padding = size === "lg" ? "px-3 py-1.5 text-[12px]" : "px-2 py-1 text-[11px]";
  return (
    <span
      data-testid={testId || `status-pill-${status}`}
      className={`inline-flex items-center gap-1.5 rounded-full font-display font-semibold ${padding}`}
      style={{ background: tone.bg, color: tone.fg }}
    >
      <span
        className="inline-block w-1.5 h-1.5 rounded-full"
        style={{ background: tone.dot }}
      />
      {status}
    </span>
  );
}
