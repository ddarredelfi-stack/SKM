import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet";
import {
  ArrowSquareOut,
  Buildings,
  Database,
  MagnifyingGlass,
  Sparkle,
  PlusCircle,
} from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../lib/api";

function renderMarkdown(md) {
  if (!md) return null;
  const lines = md.split(/\r?\n/);
  const out = [];
  let listBuf = [];
  let orderedBuf = [];
  const flush = () => {
    if (listBuf.length) {
      out.push(`<ul>${listBuf.map((l) => `<li>${l}</li>`).join("")}</ul>`);
      listBuf = [];
    }
    if (orderedBuf.length) {
      out.push(`<ol>${orderedBuf.map((l) => `<li>${l}</li>`).join("")}</ol>`);
      orderedBuf = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("### ")) {
      flush();
      out.push(`<h3>${line.slice(4)}</h3>`);
    } else if (/^\d+\.\s/.test(line)) {
      orderedBuf.push(
        line.replace(/^\d+\.\s/, "").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      );
    } else if (line.startsWith("- ") || line.startsWith("• ")) {
      listBuf.push(line.slice(2).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"));
    } else if (line === "") {
      flush();
    } else {
      flush();
      out.push(`<p>${line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`);
    }
  }
  flush();
  return out.join("");
}

const ICONS = { Buildings, Database, MagnifyingGlass };

export default function DiscoverySheet({ city, open, onOpenChange }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [strategy, setStrategy] = useState("");
  const [loading, setLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);

  useEffect(() => {
    if (!open || !city) {
      setData(null);
      setStrategy("");
      return;
    }
    setLoading(true);
    api.get(`/discovery/${encodeURIComponent(city)}`)
      .then((res) => setData(res.data))
      .catch((e) => toast.error("Kunde inte hämta länkar: " + e.message))
      .finally(() => setLoading(false));
  }, [open, city]);

  const runAi = async () => {
    setAiLoading(true);
    try {
      const res = await api.post(`/discovery/${encodeURIComponent(city)}/ai-strategy`);
      setStrategy(res.data.strategy);
      toast.success("AI-strategi klar");
    } catch (e) {
      toast.error("AI-fel: " + (e.response?.data?.detail || e.message));
    } finally {
      setAiLoading(false);
    }
  };

  const createProspect = async () => {
    let officeId = "";
    try {
      const res = await api.get("/offices", { params: { city } });
      const match = (res.data.items || []).find(
        (o) => (o.city || "").toLowerCase() === city.toLowerCase()
      );
      if (match) officeId = match.id;
    } catch {}
    navigate("/pipeline", {
      state: {
        prefill: {
          city,
          region: data?.meta?.region || "",
          type: "office",
          source: "Annat",
          office_id: officeId,
        },
      },
    });
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[680px] overflow-y-auto bg-white border-l border-[#E5E5E5] p-0"
        data-testid="discovery-sheet"
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b border-[#E5E5E5]">
          <div className="overline">Lead discovery</div>
          <SheetTitle className="font-display font-extrabold tracking-tight text-3xl text-[#0A0A0A]">
            {city}
          </SheetTitle>
          <SheetDescription className="font-body text-sm text-[#52525B] mt-1">
            {data?.meta?.region}
            {data?.meta?.population
              ? ` · ${new Intl.NumberFormat("sv-SE").format(data.meta.population)} invånare · ~${new Intl.NumberFormat("sv-SE").format(data.meta.transactions)} bostadstransaktioner/år`
              : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="px-6 py-6 flex flex-col gap-6">
          {loading && (
            <div className="text-sm text-[#52525B]">Laddar länkar…</div>
          )}

          {data && (
            <>
              {/* AI Strategy block */}
              <section className="card-surface p-5">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="overline">AI Lead-discovery-strategi</div>
                    <div className="text-[13px] text-[#52525B] mt-1 font-body">
                      Konkret aktionsplan för {city}: kandidat-arketyper, sökstrategier, värvningsvinklar.
                    </div>
                  </div>
                  <button
                    data-testid="generate-strategy-btn"
                    onClick={runAi}
                    disabled={aiLoading}
                    className="btn-primary inline-flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <Sparkle size={14} weight="duotone" />
                    {aiLoading ? "Tänker…" : strategy ? "Generera om" : "Generera"}
                  </button>
                </div>
                {strategy ? (
                  <div
                    className="brief-prose mt-3"
                    data-testid="strategy-content"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(strategy) }}
                  />
                ) : (
                  <div className="text-sm text-[#A1A1AA] py-6 text-center border border-dashed border-[#E5E5E5] rounded-md">
                    Tryck "Generera" för en skräddarsydd strategi (Claude Sonnet).
                  </div>
                )}
              </section>

              {/* Direct links */}
              {data.groups.map((g) => {
                const Icon = ICONS[g.icon] || MagnifyingGlass;
                return (
                  <section key={g.label} data-testid={`link-group-${g.label}`}>
                    <div className="flex items-center gap-2 mb-3">
                      <Icon size={16} color="#CBA135" weight="duotone" />
                      <div className="font-display font-extrabold tracking-tight text-sm uppercase letter-spacing-wide text-[#0A0A0A]">
                        {g.label}
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {g.items.map((it) => (
                        <a
                          key={it.url}
                          href={it.url}
                          target="_blank"
                          rel="noreferrer"
                          data-testid={`discovery-link-${it.label}`}
                          className="card-surface p-3 flex items-center justify-between gap-2 hover:border-[#CBA135] transition-colors group"
                        >
                          <span className="font-display font-bold text-[13px] text-[#0A0A0A] truncate">
                            {it.label}
                          </span>
                          <ArrowSquareOut
                            size={14}
                            weight="bold"
                            className="text-[#A1A1AA] group-hover:text-[#CBA135] shrink-0"
                          />
                        </a>
                      ))}
                    </div>
                  </section>
                );
              })}

              {/* Quick add prospect */}
              <section className="card-surface p-5 border border-[#E5E5E5] bg-[#FAF3E1]">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="font-display font-extrabold text-[15px] text-[#0A0A0A]">
                      Hittat en kandidat?
                    </div>
                    <div className="text-[12px] text-[#52525B] font-body mt-0.5">
                      Skapa ett prospekt med {city} förifyllt så har du namnet i pipelinen.
                    </div>
                  </div>
                  <button
                    data-testid="create-prospect-from-city"
                    onClick={createProspect}
                    className="btn-primary inline-flex items-center gap-1.5"
                  >
                    <PlusCircle size={14} weight="duotone" /> Skapa prospekt
                  </button>
                </div>
              </section>

              <p className="text-[11px] text-[#A1A1AA] font-body">
                ⚠ Lagring av personuppgifter om mäklare kräver dokumenterad rättslig grund
                (vanligen berättigat intresse). Spara endast det du faktiskt behöver för värvning.
              </p>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
