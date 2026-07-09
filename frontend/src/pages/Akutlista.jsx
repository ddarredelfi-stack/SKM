import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Warning, CaretRight } from "@phosphor-icons/react";
import { api, formatSEK, formatPct } from "../lib/api";
import KategoriPill from "../components/KategoriPill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

export default function Akutlista() {
  const [items, setItems] = useState([]);
  const [totalOffices, setTotalOffices] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get("/offices", { params: { prio: "1", sort: "oms" } }),
      api.get("/offices"),
    ])
      .then(([p1, all]) => {
        setItems(p1.data.items || []);
        setTotalOffices(all.data.total || 0);
      })
      .finally(() => setLoading(false));
  }, []);

  const totalOms = items.reduce((s, o) => s + (o.oms || 0), 0);
  const totalOmsFjol = items.reduce((s, o) => s + (o.oms_fjol || 0), 0);
  const groupYoy = totalOmsFjol ? ((totalOms - totalOmsFjol) / totalOmsFjol) * 100 : null;

  return (
    <div data-testid="akutlista-page" className="flex flex-col gap-6">
      <header>
        <div className="overline">Kontorslistan · Prio 1</div>
        <h1 className="font-display font-extrabold tracking-tighter text-4xl mt-1 flex items-center gap-3">
          <Warning size={32} color="#C94C3F" weight="duotone" /> Akutlista
        </h1>
        <p className="text-[#52525B] text-sm mt-2 font-body max-w-2xl">
          {items.length} kontor med högsta prioritet — samtliga taggade PROBLEM i kontorslistan.
          Rekommenderad åtgärd per kontor är byggd på kommentaren i underlaget kombinerat med
          allmän franchise-/rekryteringspraxis. Använd som utgångspunkt inför platsbesök och samtal.
        </p>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card-surface p-5" style={{ borderColor: "#C94C3F" }}>
          <div className="overline">Kontor i akutläge</div>
          <div className="font-display font-extrabold tracking-tighter text-3xl mt-2" style={{ color: "#C94C3F" }}>
            {items.length}
          </div>
        </div>
        <div className="card-surface p-5">
          <div className="overline">Samlad omsättning</div>
          <div className="font-display font-extrabold tracking-tighter text-3xl mt-2">{formatSEK(totalOms)}</div>
        </div>
        <div className="card-surface p-5">
          <div className="overline">YoY (grupp)</div>
          <div
            className="font-display font-extrabold tracking-tighter text-3xl mt-2"
            style={{ color: (groupYoy ?? 0) >= 0 ? "#1E5B34" : "#9A2E22" }}
          >
            {formatPct(groupYoy)}
          </div>
        </div>
        <div className="card-surface p-5">
          <div className="overline">Andel av nätverket</div>
          <div className="font-display font-extrabold tracking-tighter text-3xl mt-2">
            {items.length && totalOffices ? Math.round((items.length / totalOffices) * 100) : 0}%
          </div>
          <div className="text-[12px] text-[#52525B] font-body mt-0.5">av {totalOffices || "—"} kontor</div>
        </div>
      </section>

      <div className="card-surface overflow-hidden">
        <Table data-testid="akutlista-table">
          <TableHeader>
            <TableRow className="bg-[#FAFAFA]">
              <TableHead className="overline">Kontor</TableHead>
              <TableHead className="overline text-right">Omsättning</TableHead>
              <TableHead className="overline text-right">YoY</TableHead>
              <TableHead className="overline">Grundkommentar</TableHead>
              <TableHead className="overline">Rekommenderad åtgärd</TableHead>
              <TableHead className="overline w-8"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((o) => (
              <TableRow key={o.id} className="row-hover" style={{ background: "#FDF6F5" }}>
                <TableCell className="py-4">
                  <Link
                    to={`/offices/${o.id}`}
                    data-testid={`akutlista-row-link-${o.id}`}
                    className="font-display font-bold text-[14px] text-[#0A0A0A] hover:text-[#CBA135]"
                  >
                    {o.name}
                  </Link>
                  <div className="mt-1"><KategoriPill kategori={o.kategori} /></div>
                </TableCell>
                <TableCell className="text-right font-body text-[13px] tabular-nums whitespace-nowrap">
                  {formatSEK(o.oms)}
                </TableCell>
                <TableCell
                  className="text-right font-display font-bold text-[13px] tabular-nums whitespace-nowrap"
                  style={{ color: (o.yoy_pct ?? 0) >= 0 ? "#1E5B34" : "#9A2E22" }}
                >
                  {formatPct(o.yoy_pct)}
                </TableCell>
                <TableCell className="font-body text-[13px] text-[#52525B] max-w-[220px]">
                  {o.kommentar || "—"}
                </TableCell>
                <TableCell className="font-body text-[13px] text-[#0A0A0A] max-w-[420px] leading-relaxed">
                  {o.recommended_action || "—"}
                </TableCell>
                <TableCell>
                  <Link to={`/offices/${o.id}`} className="btn-ghost p-1.5 inline-block">
                    <CaretRight size={12} weight="bold" />
                  </Link>
                </TableCell>
              </TableRow>
            ))}
            {!loading && !items.length && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-[#A1A1AA] text-sm py-12">
                  Inga akuta kontor just nu.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
