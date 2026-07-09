import { useEffect, useRef, useState, useCallback } from "react";
import { Bell, CheckCircle } from "@phosphor-icons/react";
import { api, formatDateTime } from "../lib/api";

const KIND_ICON = {
  status_change: "→",
  created: "＋",
  lost: "✕",
  office_goal_updated: "◎",
  scrape: "⟳",
  user_created: "👤",
  user_updated: "👤",
  user_deleted: "👤",
};

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [readAt, setReadAt] = useState("");
  const panelRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get("/notifications", { params: { limit: 25 } });
      setItems(res.data.items || []);
      setUnread(res.data.unread_count || 0);
      setReadAt(res.data.read_at || "");
    } catch {
      /* backend nere — tyst, försök igen vid nästa poll */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  // Stäng vid klick utanför
  useEffect(() => {
    const onClick = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    };
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const markRead = async () => {
    try {
      const res = await api.post("/notifications/read");
      setReadAt(res.data.read_at);
      setUnread(0);
    } catch { /* ignore */ }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      load();
      markRead();
    }
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        data-testid="notification-bell"
        onClick={toggle}
        className="relative p-2 rounded-lg hover:bg-[#F4F4F5] transition-colors"
        title="Aviseringar"
      >
        <Bell size={18} weight={unread > 0 ? "fill" : "regular"}
              color={unread > 0 ? "#CBA135" : "#52525B"} />
        {unread > 0 && (
          <span
            data-testid="notification-badge"
            className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-[#C94C3F] text-white text-[10px] font-display font-bold flex items-center justify-center"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          data-testid="notification-panel"
          className="absolute left-0 top-full mt-2 w-[340px] max-h-[420px] overflow-y-auto bg-white border border-[#E5E5E5] rounded-xl shadow-lg z-50"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-[#F0F0F0] sticky top-0 bg-white">
            <span className="overline">Aviseringar</span>
            <button
              onClick={markRead}
              className="text-[11px] text-[#CBA135] font-display font-semibold inline-flex items-center gap-1 hover:underline"
            >
              <CheckCircle size={12} /> Markera lästa
            </button>
          </div>
          {items.length === 0 && (
            <div className="px-4 py-8 text-center text-[13px] text-[#A1A1AA] font-body">
              Inga händelser ännu.
            </div>
          )}
          {items.map((a) => {
            const isUnread = readAt ? a.created_at > readAt : true;
            return (
              <div
                key={a.id}
                className={`px-4 py-3 border-b border-[#F7F7F7] ${isUnread ? "bg-[#FDF9EF]" : ""}`}
              >
                <div className="flex items-start gap-2">
                  <span className="text-[13px] w-4 text-center shrink-0" style={{ color: a.important ? "#C94C3F" : "#A1A1AA" }}>
                    {KIND_ICON[a.kind] || "•"}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[13px] font-body text-[#0A0A0A] leading-snug">
                      {a.message}
                      {a.important && (
                        <span className="ml-1.5 text-[10px] uppercase tracking-wide font-display font-bold text-[#C94C3F]">Viktig</span>
                      )}
                    </div>
                    <div className="text-[11px] text-[#A1A1AA] font-body mt-0.5">
                      {a.actor_name ? `${a.actor_name} · ` : ""}{formatDateTime(a.created_at)}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
