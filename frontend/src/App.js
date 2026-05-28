import "@/index.css";
import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider, useAuth } from "@/lib/auth";
import Layout from "@/components/Layout";
import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import Pipeline from "@/pages/Pipeline";
import Offices from "@/pages/Offices";
import Brokers from "@/pages/Brokers";
import MapView from "@/pages/MapView";
import Scrape from "@/pages/Scrape";
import Settings from "@/pages/Settings";
import Team from "@/pages/Team";
import Lost from "@/pages/Lost";
import OfficeDetail from "@/pages/OfficeDetail";

function ProtectedRoute({ children, adminOnly = false }) {
  const { user } = useAuth();
  const location = useLocation();
  if (user === null) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-[#52525B] font-body">
        Laddar…
      </div>
    );
  }
  if (user === false) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  if (adminOnly && user.role !== "admin") {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          <div className="overline">403</div>
          <h2 className="font-display font-extrabold tracking-tight text-2xl mt-1">Endast admin</h2>
          <p className="text-sm text-[#52525B] mt-2 font-body">
            Du har inte behörighet att se den här sidan.
          </p>
        </div>
      </div>
    );
  }
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <Layout>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/pipeline" element={<Pipeline />} />
                <Route path="/offices" element={<Offices />} />
                <Route path="/offices/:id" element={<OfficeDetail />} />
                <Route path="/brokers" element={<Brokers />} />
                <Route path="/map" element={<MapView />} />
                <Route path="/scrape" element={<Scrape />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/team" element={<Team />} />
                <Route path="/lost" element={<Lost />} />
              </Routes>
            </Layout>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <div className="App">
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
      <Toaster position="top-right" richColors closeButton />
    </div>
  );
}
