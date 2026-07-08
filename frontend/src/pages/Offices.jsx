import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { MagnifyingGlass, DownloadSimple, MapPin, Phone, EnvelopeSimple, ArrowSquareOut, CaretRight } from "@phosphor-icons/react";
import { api, downloadCsv, formatSEK, formatPct } from "../lib/api";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import KategoriPill from "../components/KategoriPill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

export default function Offices() {
  const [items, setItems] = useState([]);
  const [q, setQ] = useState("");
  const [kategori, setKategori] = useState("all");
  const [prio, setPrio] = useState("all");
  const [sort, setSort] = useState("prio");

  const load = async () => {
    const res = await api.get("/offices", {
      params: {
        q,
        sort,
        kategori: kategori === "all" ? "" : kategori,
        prio: prio === "all" ? "" : prio,
      },
    });
    setItems(res.data.items || []);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [q, kategori, prio, sort]);

  return (
    <div data-testid="offices-page" className="flex flex-col gap-6">
      <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <div className="overline">Närvaro</div>
          <h1 className="font-display font-extrabold tracking-tighter text-4xl mt-1">
            Kontor i kedjan
          </h1>
          <p className="text-[#52525B] text-sm mt-2 font-body">
            {items.length} kontor. Kategori/prio från kontorslistan — klicka för detaljer.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="relative">
            <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A1A1AA]" />
            <Input
              data-testid="offices-search"
              placeholder="Sök kontor, ort, chef…"
              className="input-base pl-8 w-60"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <Select value={kategori} onValueChange={setKategori}>
            <SelectTrigger data-testid="offices-filter-kategori" className="w-36 h-9 text-[13px]">
              <SelectValue placeholder="Kategori" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alla kategorier</SelectItem>
              <SelectItem value="PROBLEM">Problem</SelectItem>
              <SelectItem value="UTMANINGAR">Utmaningar</SelectItem>
              <SelectItem value="OK">OK/Kör</SelectItem>
            </SelectContent>
          </Select>
          <Select value={prio} onValueChange={setPrio}>
            <SelectTrigger data-testid="offices-filter-prio" className="w-32 h-9 text-[13px]">
              <SelectValue placeholder="Prio" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alla prio</SelectItem>
              <SelectItem value="1">Prio 1</SelectItem>
              <SelectItem value="2">Prio 2</SelectItem>
              <SelectItem value="3">Prio 3</SelectItem>
              <SelectItem value="4">Prio 4</SelectItem>
              <SelectItem value="5">Prio 5</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={setSort}>
            <SelectTrigger data-testid="offices-sort" className="w-40 h-9 text-[13px]">
              <SelectValue placeholder="Sortering" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="prio">Prio (akut först)</SelectItem>
              <SelectItem value="oms">Omsättning (störst)</SelectItem>
              <SelectItem value="yoy">YoY % (sämst först)</SelectItem>
              <SelectItem value="name">Namn (A–Ö)</SelectItem>
            </SelectContent>
          </Select>
          <button
            data-testid="export-offices-csv"
            onClick={() => downloadCsv("/export/offices.csv", "skandia-kontor.csv")}
            className="btn-secondary inline-flex items-center gap-1.5"
          >
            <DownloadSimple size={14} /> CSV
          </button>
        </div>
      </header>

      <div className="card-surface overflow-hidden">
        <Table data-testid="offices-table">
          <TableHeader>
            <TableRow className="bg-[#FAFAFA]">
              <TableHead className="overline">Kontor</TableHead>
              <TableHead className="overline">Ort / Region</TableHead>
              <TableHead className="overline">Kategori</TableHead>
              <TableHead className="overline">Prio</TableHead>
              <TableHead className="overline text-right">Omsättning</TableHead>
              <TableHead className="overline text-right">YoY</TableHead>
              <TableHead className="overline">Kontorschef</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((o) => (
              <TableRow key={o.id} className="row-hover">
                <TableCell className="py-4">
                  <div className="flex items-center gap-2">
                    <Link
                      to={`/offices/${o.id}`}
                      data-testid={`office-row-link-${o.id}`}
                      className="font-display font-bold text-[14px] text-[#0A0A0A] hover:text-[#CBA135] inline-flex items-center gap-1"
                    >
                      {o.name}
                      <CaretRight size={12} weight="bold" className="text-[#A1A1AA]" />
                    </Link>
                    {o.website && (
                      <a
                        href={o.website}
                        target="_blank"
                        rel="noreferrer"
                        title="Öppna på skandiamaklarna.se"
                        data-testid={`office-link-${o.id}`}
                        className="text-[#A1A1AA] hover:text-[#CBA135] transition-colors"
                      >
                        <ArrowSquareOut size={14} weight="bold" />
                      </a>
                    )}
                  </div>
                  {o.kommentar && (
                    <div className="text-[12px] text-[#52525B] font-body flex items-center gap-1 mt-0.5">
                      <MapPin size={11} /> {o.kommentar}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="font-body text-[13px] text-[#0A0A0A]">{o.city}</div>
                  <div className="text-[12px] text-[#52525B] font-body">{o.region}</div>
                </TableCell>
                <TableCell><KategoriPill kategori={o.kategori} /></TableCell>
                <TableCell className="font-display font-bold text-[13px]">
                  {o.prio ? `Prio ${o.prio}` : "—"}
                </TableCell>
                <TableCell className="text-right font-body text-[13px] tabular-nums">
                  {formatSEK(o.oms)}
                </TableCell>
                <TableCell
                  className="text-right font-display font-bold text-[13px] tabular-nums"
                  style={{ color: (o.yoy_pct ?? 0) >= 0 ? "#1E5B34" : "#9A2E22" }}
                >
                  {formatPct(o.yoy_pct)}
                </TableCell>
                <TableCell className="font-body text-[13px] text-[#0A0A0A]">{o.manager || "—"}</TableCell>
              </TableRow>
            ))}
            {!items.length && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-[#A1A1AA] text-sm py-12">
                  Inga kontor matchar.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

