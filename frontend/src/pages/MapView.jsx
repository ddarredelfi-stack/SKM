import { useEffect, useState } from "react";
import { api, formatNumber } from "../lib/api";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";
import SwedenMap from "../components/SwedenMap";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

export default function MapView() {
  const [whitespots, setWhitespots] = useState([]);
  const [mode, setMode] = useState("all");

  useEffect(() => {
    api.get("/geo/whitespots", { params: { min_population: 25000, limit: 30 } })
      .then((r) => setWhitespots(r.data.items));
  }, []);

  return (
    <div data-testid="map-page" className="flex flex-col gap-6">
      <header>
        <div className="overline">Geografisk översikt</div>
        <h1 className="font-display font-extrabold tracking-tighter text-4xl mt-1">
          Karta & White Spots
        </h1>
        <p className="text-[#52525B] text-sm mt-2 font-body max-w-2xl">
          Svarta cirklar = Skandiamäklarna har närvaro. Champagne-cirklar = white spots.
          Sortera tabellen efter opportunity score för att hitta högst potential.
        </p>
      </header>

      <Tabs defaultValue="all" onValueChange={setMode}>
        <TabsList data-testid="map-tabs" className="bg-[#F4F4F5]">
          <TabsTrigger value="all" data-testid="map-tab-all">Alla</TabsTrigger>
          <TabsTrigger value="covered" data-testid="map-tab-covered">Skandia-närvaro</TabsTrigger>
          <TabsTrigger value="whitespots" data-testid="map-tab-whitespots">White Spots</TabsTrigger>
        </TabsList>
        <TabsContent value="all" className="mt-4"><SwedenMap mode="all" height={520} /></TabsContent>
        <TabsContent value="covered" className="mt-4"><SwedenMap mode="covered" height={520} /></TabsContent>
        <TabsContent value="whitespots" className="mt-4"><SwedenMap mode="whitespots" height={520} /></TabsContent>
      </Tabs>

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <div className="overline">Topp 30</div>
            <h2 className="font-display font-extrabold tracking-tight text-2xl mt-1">
              Prioriterade white spots
            </h2>
          </div>
          <div className="text-xs text-[#52525B] font-body">
            Sorterat efter opportunity score
          </div>
        </div>
        <div className="card-surface overflow-hidden">
          <Table data-testid="whitespots-table">
            <TableHeader>
              <TableRow className="bg-[#FAFAFA]">
                <TableHead className="overline">Kommun</TableHead>
                <TableHead className="overline">Region</TableHead>
                <TableHead className="overline text-right">Befolkning</TableHead>
                <TableHead className="overline text-right">Transaktioner/år</TableHead>
                <TableHead className="overline">Konkurrenter</TableHead>
                <TableHead className="overline text-right">Score</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {whitespots.map((m) => (
                <TableRow key={m.name} className="row-hover" data-testid={`whitespot-${m.name}`}>
                  <TableCell className="font-display font-bold text-[#0A0A0A]">{m.name}</TableCell>
                  <TableCell className="font-body text-sm text-[#52525B]">{m.region}</TableCell>
                  <TableCell className="text-right tabular-nums font-body text-sm">{formatNumber(m.population)}</TableCell>
                  <TableCell className="text-right tabular-nums font-body text-sm">~{formatNumber(m.transactions)}</TableCell>
                  <TableCell className="font-body text-[12px] text-[#52525B]">{m.competitors.join(", ")}</TableCell>
                  <TableCell className="text-right font-display font-extrabold text-[#CBA135] tabular-nums">{m.opportunity_score}</TableCell>
                </TableRow>
              ))}
              {!whitespots.length && (
                <TableRow><TableCell colSpan={6} className="text-center py-12 text-[#A1A1AA] text-sm">Laddar…</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}
