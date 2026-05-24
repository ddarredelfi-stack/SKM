import axios from "axios";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API_BASE = `${BACKEND_URL}/api`;

export const api = axios.create({
  baseURL: API_BASE,
  headers: { "Content-Type": "application/json" },
  withCredentials: true,
});

export const PIPELINE_STATUSES = [
  "Identifierad",
  "Kontaktad",
  "Möte bokat",
  "Förhandling",
  "Signerad",
  "Onboardad",
];

export const STATUS_TONE = {
  Identifierad: { bg: "#F4F4F5", fg: "#52525B", dot: "#A1A1AA" },
  Kontaktad: { bg: "#FEF9C3", fg: "#854D0E", dot: "#EAB308" },
  "Möte bokat": { bg: "#FEF08A", fg: "#713F12", dot: "#CA8A04" },
  Förhandling: { bg: "#FAF3E1", fg: "#7C5A0F", dot: "#CBA135" },
  Signerad: { bg: "#DCFCE7", fg: "#14532D", dot: "#22C55E" },
  Onboardad: { bg: "#0A0A0A", fg: "#FFFFFF", dot: "#CBA135" },
};

export const PROSPECT_SOURCES = [
  "LinkedIn",
  "Rekommendation",
  "Event/Mässa",
  "Webbformulär",
  "Cold outreach",
  "Hemnet/Booli",
  "Scrape",
  "Annat",
];

export const COMPETITOR_AGENCIES = [
  "Fastighetsbyrån",
  "Svensk Fastighetsförmedling",
  "Länsförsäkringar Fastighetsförmedling",
  "HusmanHagberg",
  "ERA",
  "Mäklarhuset",
  "Bjurfors",
  "Notar",
  "Erik Olsson Fastighetsförmedling",
  "Mäklarringen",
  "Egen byrå",
  "Annan",
];

export const daysSince = (iso) => {
  if (!iso) return 0;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
};

export const formatNumber = (n) =>
  typeof n === "number" ? new Intl.NumberFormat("sv-SE").format(n) : n;

export const formatDate = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("sv-SE", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
};

export const formatDateTime = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("sv-SE", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
};

export const downloadCsv = async (endpoint, filename) => {
  const res = await api.get(endpoint, { responseType: "blob" });
  const blob = new Blob([res.data], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
