import { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Tooltip, Popup } from "react-leaflet";
import { api } from "../lib/api";

const POSITRON =
  "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

export default function SwedenMap({ height = 520, mode = "all" }) {
  const [data, setData] = useState({ items: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api.get("/geo/municipalities").then((res) => {
      if (live) {
        setData(res.data);
        setLoading(false);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  const items = useMemo(() => {
    if (mode === "whitespots") return data.items.filter((m) => !m.has_skandia);
    if (mode === "covered") return data.items.filter((m) => m.has_skandia);
    return data.items;
  }, [data, mode]);

  return (
    <div
      data-testid="sweden-map"
      className="card-surface overflow-hidden relative"
      style={{ height }}
    >
      {loading && (
        <div className="absolute inset-0 z-[400] flex items-center justify-center bg-white/80 text-sm text-[#52525B]">
          Laddar karta…
        </div>
      )}
      <MapContainer
        center={[62.0, 16.0]}
        zoom={5}
        minZoom={4}
        maxZoom={10}
        scrollWheelZoom={true}
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer url={POSITRON} attribution={ATTRIBUTION} />
        {items.map((m) => {
          const covered = m.has_skandia;
          const radius = Math.max(6, Math.min(22, Math.sqrt(m.population) / 60));
          return (
            <CircleMarker
              key={m.name}
              center={[m.lat, m.lng]}
              radius={radius}
              pathOptions={{
                color: covered ? "#0A0A0A" : "#CBA135",
                fillColor: covered ? "#0A0A0A" : "#CBA135",
                fillOpacity: covered ? 0.85 : 0.25,
                weight: covered ? 1 : 2,
              }}
            >
              <Tooltip direction="top" offset={[0, -radius]}>
                <span className="font-display font-semibold">
                  {m.name} {covered ? "· Skandia" : "· White spot"}
                </span>
              </Tooltip>
              <Popup>
                <div className="text-sm font-body" style={{ minWidth: 200 }}>
                  <div className="font-display font-extrabold text-[15px] mb-1">{m.name}</div>
                  <div className="text-[#52525B] mb-2">{m.region}</div>
                  <div className="flex justify-between border-t border-[#E5E5E5] pt-2 mt-1">
                    <span className="text-[#52525B]">Befolkning</span>
                    <span className="font-semibold">{new Intl.NumberFormat("sv-SE").format(m.population)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#52525B]">Bostadstransaktioner / år</span>
                    <span className="font-semibold">~{new Intl.NumberFormat("sv-SE").format(m.transactions)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#52525B]">Konkurrenter</span>
                    <span className="font-semibold">{m.competitor_count}</span>
                  </div>
                  <div className="mt-2 pt-2 border-t border-[#E5E5E5]">
                    {covered ? (
                      <span className="text-[#16A34A] font-display font-bold text-xs uppercase tracking-wider">
                        ● Skandia finns
                      </span>
                    ) : (
                      <span className="text-[#CBA135] font-display font-bold text-xs uppercase tracking-wider">
                        ○ White spot
                      </span>
                    )}
                  </div>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>
    </div>
  );
}
