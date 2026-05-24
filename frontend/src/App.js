import "@/index.css";
import "@/App.css";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import Layout from "@/components/Layout";
import Dashboard from "@/pages/Dashboard";
import Pipeline from "@/pages/Pipeline";
import Offices from "@/pages/Offices";
import Brokers from "@/pages/Brokers";
import MapView from "@/pages/MapView";
import Scrape from "@/pages/Scrape";
import Settings from "@/pages/Settings";

export default function App() {
  return (
    <div className="App">
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/pipeline" element={<Pipeline />} />
            <Route path="/offices" element={<Offices />} />
            <Route path="/brokers" element={<Brokers />} />
            <Route path="/map" element={<MapView />} />
            <Route path="/scrape" element={<Scrape />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </Layout>
      </BrowserRouter>
      <Toaster position="top-right" richColors closeButton />
    </div>
  );
}
