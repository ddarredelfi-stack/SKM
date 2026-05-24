import { NavLink } from "react-router-dom";
import {
  ChartBar,
  Kanban,
  Buildings,
  UsersThree,
  MapTrifold,
  GearSix,
  ArrowsClockwise,
  Compass,
  SignOut,
  UsersFour,
  XCircle,
} from "@phosphor-icons/react";
import { useAuth } from "../lib/auth";

const links = [
  { to: "/", label: "Översikt", icon: ChartBar, end: true, testId: "nav-dashboard" },
  { to: "/pipeline", label: "Pipeline", icon: Kanban, testId: "nav-pipeline" },
  { to: "/lost", label: "Förlorade", icon: XCircle, testId: "nav-lost" },
  { to: "/offices", label: "Kontor", icon: Buildings, testId: "nav-offices" },
  { to: "/brokers", label: "Mäklare", icon: UsersThree, testId: "nav-brokers" },
  { to: "/map", label: "Karta & White Spots", icon: MapTrifold, testId: "nav-map" },
  { to: "/scrape", label: "Scraping", icon: ArrowsClockwise, testId: "nav-scrape" },
  { to: "/settings", label: "Mål & Inställningar", icon: GearSix, testId: "nav-settings" },
  { to: "/team", label: "Mitt team", icon: UsersFour, testId: "nav-team" },
];

export default function Sidebar() {
  const { user, logout } = useAuth();
  return (
    <aside
      data-testid="sidebar"
      className="hidden md:flex flex-col w-64 shrink-0 bg-white border-r border-[#E5E5E5] h-screen sticky top-0"
    >
      <div className="px-6 pt-7 pb-6 border-b border-[#E5E5E5]">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-md bg-[#0A0A0A] flex items-center justify-center">
            <Compass size={18} weight="duotone" color="#CBA135" />
          </div>
          <div className="leading-tight">
            <div className="font-display font-extrabold tracking-tight text-[#0A0A0A] text-[15px]">
              Etablering
            </div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-[#A1A1AA] font-display font-semibold">
              Skandiamäklarna
            </div>
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 flex flex-col gap-0.5">
        <div className="overline px-3 pb-2 pt-1">Arbetsyta</div>
        {links.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            data-testid={l.testId}
            className={({ isActive }) =>
              `sidebar-link ${isActive ? "active" : ""}`
            }
          >
            <l.icon size={16} weight="regular" />
            <span>{l.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="px-5 py-4 border-t border-[#E5E5E5]">
        <div className="overline pb-1.5">Inloggad som</div>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div
              className="font-display font-bold text-[#0A0A0A] text-sm truncate"
              data-testid="sidebar-user-name"
            >
              {user?.name || "—"}
            </div>
            <div className="text-[12px] text-[#52525B] flex items-center gap-1.5">
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: user?.role === "admin" ? "#CBA135" : "#A1A1AA" }}
              />
              {user?.role === "admin" ? "Admin" : "Medlem"}
            </div>
          </div>
          <button
            data-testid="sidebar-logout"
            onClick={logout}
            title="Logga ut"
            className="btn-ghost p-1.5"
          >
            <SignOut size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
}
