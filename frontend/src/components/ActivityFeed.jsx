import {
  Sparkle,
  ArrowsLeftRight,
  Robot,
  EnvelopeSimple,
  PlusCircle,
  Trash,
  ArrowsClockwise,
} from "@phosphor-icons/react";
import { formatDateTime } from "../lib/api";

const ICONS = {
  status_change: ArrowsLeftRight,
  created: PlusCircle,
  deleted: Trash,
  ai_brief: Robot,
  reminder: EnvelopeSimple,
  scrape: ArrowsClockwise,
};

export default function ActivityFeed({ items = [] }) {
  if (!items.length) {
    return (
      <div className="text-[13px] text-[#52525B] py-8 text-center" data-testid="activity-empty">
        Ingen aktivitet ännu.
      </div>
    );
  }
  return (
    <ul className="flex flex-col" data-testid="activity-feed">
      {items.map((a, idx) => {
        const Icon = ICONS[a.kind] || Sparkle;
        return (
          <li
            key={a.id}
            data-testid={`activity-item-${idx}`}
            className="flex items-start gap-3 py-3 border-b border-[#E5E5E5] last:border-0"
          >
            <div className="mt-0.5 w-7 h-7 rounded-md bg-[#FAFAFA] border border-[#E5E5E5] flex items-center justify-center shrink-0">
              <Icon size={14} color="#52525B" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] text-[#0A0A0A] font-body">{a.message}</div>
              <div className="text-[11px] text-[#A1A1AA] font-display font-semibold uppercase tracking-wider mt-0.5">
                {formatDateTime(a.created_at)}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
