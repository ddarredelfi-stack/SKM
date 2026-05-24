import { useEffect, useState } from "react";
import { MagnifyingGlass, DownloadSimple, MapPin, Phone, EnvelopeSimple } from "@phosphor-icons/react";
import { api, downloadCsv } from "../lib/api";
import { Input } from "../components/ui/input";
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

  const load = async () => {
    const res = await api.get("/offices", { params: { q } });
    setItems(res.data.items || []);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [q]);

  return (
    <div data-testid="offices-page" className="flex flex-col gap-6">
      <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <div className="overline">Närvaro</div>
          <h1 className="font-display font-extrabold tracking-tighter text-4xl mt-1">
            Kontor i kedjan
          </h1>
          <p className="text-[#52525B] text-sm mt-2 font-body">
            {items.length} kontor totalt. Klicka för detaljer.
          </p>
        </div>
        <div className="flex gap-2">
          <div className="relative">
            <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A1A1AA]" />
            <Input
              data-testid="offices-search"
              placeholder="Sök kontor, ort, chef…"
              className="input-base pl-8 w-72"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
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
              <TableHead className="overline">Kontorschef</TableHead>
              <TableHead className="overline">Kontakt</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((o) => (
              <TableRow key={o.id} className="row-hover">
                <TableCell className="py-4">
                  <div className="font-display font-bold text-[14px] text-[#0A0A0A]">{o.name}</div>
                  <div className="text-[12px] text-[#52525B] font-body flex items-center gap-1 mt-0.5">
                    <MapPin size={11} /> {o.address}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="font-body text-[13px] text-[#0A0A0A]">{o.city}</div>
                  <div className="text-[12px] text-[#52525B] font-body">{o.region}</div>
                </TableCell>
                <TableCell className="font-body text-[13px] text-[#0A0A0A]">{o.manager}</TableCell>
                <TableCell>
                  <div className="flex gap-3 text-[12px] font-body text-[#52525B]">
                    <a href={`tel:${o.phone}`} className="inline-flex items-center gap-1 hover:text-[#CBA135]">
                      <Phone size={11} /> {o.phone}
                    </a>
                    <a href={`mailto:${o.email}`} className="inline-flex items-center gap-1 hover:text-[#CBA135]">
                      <EnvelopeSimple size={11} /> Mejla
                    </a>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!items.length && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-[#A1A1AA] text-sm py-12">
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
