import { useEffect, useState } from "react";
import { ArrowCounterClockwise, MagnifyingGlass, DownloadSimple, Warning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, downloadCsv, formatDate } from "../lib/api";
import { Input } from "../components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

export default function Lost() {
  const [items, setItems] = useState([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(null);

  const load = async () => {
    // include_lost=true & status=any
    const res = await api.get("/prospects", { params: { q, include_lost: true } });
    const lost = (res.data.items || []).filter((p) => p.is_lost);
    setItems(lost);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const restore = async (p) => {
    if (!confirm(`Återställ ${p.name} till pipeline?`)) return;
    setBusy(p.id);
    try {
      await api.post(`/prospects/${p.id}/restore`);
      toast.success(`${p.name} återställd`);
      load();
    } catch (e) {
      toast.error("Kunde inte återställa: " + e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="lost-page" className="flex flex-col gap-6">
      <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <div className="overline">Förlorade prospekt</div>
          <h1 className="font-display font-extrabold tracking-tighter text-4xl mt-1">
            Förlorade till konkurrenter
          </h1>
          <p className="text-[#52525B] text-sm mt-2 font-body max-w-2xl">
            {items.length} prospekt som tackat nej eller gått till annan kedja.
            Återställ för att flytta tillbaka till aktiva pipelinen.
          </p>
        </div>
        <div className="flex gap-2">
          <div className="relative">
            <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A1A1AA]" />
            <Input
              data-testid="lost-search"
              placeholder="Sök namn, ort, kedja…"
              className="input-base pl-8 w-72"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <button
            data-testid="export-lost-csv"
            onClick={() => downloadCsv("/export/prospects.csv", "skandia-prospekt-alla.csv")}
            className="btn-secondary inline-flex items-center gap-1.5"
          >
            <DownloadSimple size={14} /> CSV
          </button>
        </div>
      </header>

      <div className="card-surface overflow-hidden">
        <Table data-testid="lost-table">
          <TableHeader>
            <TableRow className="bg-[#FAFAFA]">
              <TableHead className="overline">Prospekt</TableHead>
              <TableHead className="overline">Förlorad till</TableHead>
              <TableHead className="overline">Anledning</TableHead>
              <TableHead className="overline">Förlorad</TableHead>
              <TableHead className="overline w-28"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((p) => (
              <TableRow key={p.id} className="row-hover" data-testid={`lost-row-${p.id}`}>
                <TableCell>
                  <div className="font-display font-bold text-[14px] text-[#0A0A0A]">{p.name}</div>
                  <div className="text-[12px] text-[#52525B] font-body">
                    {p.city || "—"}{p.current_agency ? ` · från ${p.current_agency}` : ""}
                  </div>
                </TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded font-display font-bold text-[12px] bg-[#FEF2F2] text-[#7F1D1D]">
                    <Warning size={11} weight="duotone" /> {p.lost_to_agency || "—"}
                  </span>
                </TableCell>
                <TableCell className="text-sm text-[#52525B] font-body max-w-md">
                  {p.lost_reason || <span className="text-[#A1A1AA]">—</span>}
                </TableCell>
                <TableCell className="text-sm font-body text-[#52525B]">
                  {formatDate(p.lost_at)}
                </TableCell>
                <TableCell>
                  <button
                    onClick={() => restore(p)}
                    disabled={busy === p.id}
                    className="btn-secondary inline-flex items-center gap-1 text-xs"
                    data-testid={`restore-${p.id}`}
                  >
                    <ArrowCounterClockwise size={12} /> Återställ
                  </button>
                </TableCell>
              </TableRow>
            ))}
            {!items.length && (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-12 text-[#A1A1AA] text-sm">
                  Inga förlorade prospekt än. Bra jobbat.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
