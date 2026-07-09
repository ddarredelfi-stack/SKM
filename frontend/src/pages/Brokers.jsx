import { useEffect, useState } from "react";
import { MagnifyingGlass, DownloadSimple, Phone, EnvelopeSimple, ArrowSquareOut } from "@phosphor-icons/react";
import { api, downloadCsv, formatNumber } from "../lib/api";
import { Input } from "../components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

export default function Brokers() {
  const [items, setItems] = useState([]);
  const [roleCounts, setRoleCounts] = useState({});
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");

  const load = async () => {
    const res = await api.get("/brokers", { params: { q, role, limit: 500 } });
    setItems(res.data.items || []);
    setRoleCounts(res.data.role_counts || {});
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [q, role]);

  const totalAll = Object.values(roleCounts).reduce((a, b) => a + b, 0);
  const ROLE_ORDER = [
    "Partner/Franchisetagare",
    "Kontorschef",
    "Fastighetsmäklare",
    "Koordinator",
    "Assistent",
    "Övrig roll",
  ];

  return (
    <div data-testid="brokers-page" className="flex flex-col gap-6">
      <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <div className="overline">Människor</div>
          <h1 className="font-display font-extrabold tracking-tighter text-4xl mt-1">
            Medarbetare
          </h1>
          <p className="text-[#52525B] text-sm mt-2 font-body">
            Visar {formatNumber(items.length)} personer{role ? ` · ${role}` : ""}. Roll härleds från titeln på skandiamaklarna.se.
          </p>
        </div>
        <div className="flex gap-2">
          <div className="relative">
            <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A1A1AA]" />
            <Input
              data-testid="brokers-search"
              placeholder="Sök namn, ort, kontor…"
              className="input-base pl-8 w-72"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <button
            data-testid="export-brokers-csv"
            onClick={() => downloadCsv("/export/brokers.csv", "skandia-maklare.csv")}
            className="btn-secondary inline-flex items-center gap-1.5"
          >
            <DownloadSimple size={14} /> CSV
          </button>
        </div>
      </header>

      {/* Rollfilter */}
      <div className="flex flex-wrap gap-2" data-testid="role-filter">
        <button
          onClick={() => setRole("")}
          data-testid="role-chip-alla"
          className={`px-3 py-1.5 rounded-full text-[12px] font-display font-semibold border transition-colors ${
            role === "" ? "bg-[#0A0A0A] text-white border-[#0A0A0A]" : "bg-white text-[#52525B] border-[#E5E5E5] hover:border-[#0A0A0A]"
          }`}
        >
          Alla ({totalAll})
        </button>
        {ROLE_ORDER.filter((r) => roleCounts[r] > 0).map((r) => (
          <button
            key={r}
            onClick={() => setRole(role === r ? "" : r)}
            data-testid={`role-chip-${r}`}
            className={`px-3 py-1.5 rounded-full text-[12px] font-display font-semibold border transition-colors ${
              role === r ? "bg-[#0A0A0A] text-white border-[#0A0A0A]" : "bg-white text-[#52525B] border-[#E5E5E5] hover:border-[#0A0A0A]"
            }`}
          >
            {r} ({roleCounts[r]})
          </button>
        ))}
      </div>

      <div className="card-surface overflow-hidden">
        <Table data-testid="brokers-table">
          <TableHeader>
            <TableRow className="bg-[#FAFAFA]">
              <TableHead className="overline">Mäklare</TableHead>
              <TableHead className="overline">Roll</TableHead>
              <TableHead className="overline">Kontor</TableHead>
              <TableHead className="overline">Aktiva objekt</TableHead>
              <TableHead className="overline">YTD sålda</TableHead>
              <TableHead className="overline">Kontakt</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((b) => (
              <TableRow key={b.id} className="row-hover">
                <TableCell className="py-3">
                  <div className="flex items-center gap-3">
                    <img
                      src={b.avatar_url}
                      alt=""
                      className="w-9 h-9 rounded-full object-cover border border-[#E5E5E5]"
                      onError={(e) => { e.target.style.display = "none"; }}
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <div className="font-display font-bold text-[13px] text-[#0A0A0A]">{b.name}</div>
                        {b.profile_url && (
                          <a
                            href={b.profile_url}
                            target="_blank"
                            rel="noreferrer"
                            title="Öppna profil på skandiamaklarna.se"
                            data-testid={`broker-link-${b.id}`}
                            className="text-[#A1A1AA] hover:text-[#CBA135] transition-colors"
                          >
                            <ArrowSquareOut size={12} weight="bold" />
                          </a>
                        )}
                      </div>
                      <div className="text-[11px] text-[#A1A1AA] font-body">{b.email}</div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-[13px] font-body text-[#52525B]">
                  <span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-display font-semibold bg-[#F4F4F5] text-[#0A0A0A] mb-0.5">
                    {b.role_category || "—"}
                  </span>
                  <div className="text-[11px] text-[#A1A1AA]">{b.title}</div>
                </TableCell>
                <TableCell>
                  <div className="text-[13px] font-body text-[#0A0A0A]">{b.office_name}</div>
                  <div className="text-[11px] text-[#A1A1AA] font-body">{b.city}</div>
                </TableCell>
                <TableCell className="font-display font-bold text-[13px] tabular-nums">{b.active_listings}</TableCell>
                <TableCell className="font-display font-bold text-[13px] tabular-nums text-[#CBA135]">{b.ytd_sales}</TableCell>
                <TableCell>
                  <div className="flex gap-3 text-[12px] font-body text-[#52525B]">
                    <a href={`tel:${b.phone}`} className="inline-flex items-center gap-1 hover:text-[#CBA135]">
                      <Phone size={11} /> {b.phone}
                    </a>
                    <a href={`mailto:${b.email}`} className="inline-flex items-center gap-1 hover:text-[#CBA135]">
                      <EnvelopeSimple size={11} />
                    </a>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!items.length && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-[#A1A1AA] text-sm py-12">
                  Inga mäklare matchar.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
