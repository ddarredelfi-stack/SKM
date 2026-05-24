import { useState } from "react";
import { List, X } from "@phosphor-icons/react";
import { NavLink } from "react-router-dom";
import Sidebar from "./Sidebar";

const mobileLinks = [
  { to: "/", label: "Översikt", end: true },
  { to: "/pipeline", label: "Pipeline" },
  { to: "/lost", label: "Förlorade" },
  { to: "/offices", label: "Kontor" },
  { to: "/brokers", label: "Mäklare" },
  { to: "/map", label: "Karta" },
  { to: "/scrape", label: "Scraping" },
  { to: "/settings", label: "Inställningar" },
  { to: "/team", label: "Mitt team" },
];

export default function Layout({ children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-screen bg-[#FAFAFA]">
      <Sidebar />

      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-40 bg-white border-b border-[#E5E5E5] px-4 py-3 flex items-center justify-between">
        <div className="font-display font-extrabold tracking-tight">
          Etablering · <span className="text-[#CBA135]">Skandia</span>
        </div>
        <button
          data-testid="mobile-menu-toggle"
          onClick={() => setOpen((v) => !v)}
          className="btn-ghost"
        >
          {open ? <X size={20} /> : <List size={20} />}
        </button>
      </div>

      {open && (
        <div className="md:hidden fixed inset-0 z-30 bg-black/40" onClick={() => setOpen(false)}>
          <div
            className="absolute top-[56px] left-0 right-0 bg-white border-b border-[#E5E5E5] py-2 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {mobileLinks.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.end}
                onClick={() => setOpen(false)}
                data-testid={`mobile-nav-${l.to.replace("/", "") || "home"}`}
                className={({ isActive }) =>
                  `px-5 py-3 text-sm font-display font-semibold ${
                    isActive ? "text-[#0A0A0A] bg-[#F4F4F5]" : "text-[#52525B]"
                  }`
                }
              >
                {l.label}
              </NavLink>
            ))}
          </div>
        </div>
      )}

      <main className="flex-1 min-w-0 pt-[60px] md:pt-0">
        <div className="max-w-[1600px] mx-auto px-4 md:px-10 py-6 md:py-10">
          {children}
        </div>
      </main>
    </div>
  );
}
