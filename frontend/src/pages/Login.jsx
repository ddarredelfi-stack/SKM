import { useState } from "react";
import { useNavigate, Navigate } from "react-router-dom";
import { Compass, SignIn } from "@phosphor-icons/react";
import { useAuth, formatApiError } from "../lib/auth";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

export default function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (user && user !== false) return <Navigate to="/" replace />;

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email.trim(), password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(formatApiError(err.response?.data?.detail) || err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      data-testid="login-page"
      className="min-h-screen flex items-center justify-center bg-[#FAFAFA] px-4"
    >
      <div className="w-full max-w-[400px]">
        <div className="flex items-center gap-2.5 mb-10">
          <div className="w-9 h-9 rounded-md bg-[#0A0A0A] flex items-center justify-center">
            <Compass size={18} weight="duotone" color="#CBA135" />
          </div>
          <div className="leading-tight">
            <div className="font-display font-extrabold tracking-tight text-[#0A0A0A] text-base">
              Etablering
            </div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-[#A1A1AA] font-display font-semibold">
              Skandiamäklarna
            </div>
          </div>
        </div>

        <div className="overline">Logga in</div>
        <h1 className="font-display font-extrabold tracking-tighter text-[#0A0A0A] text-4xl mt-1">
          Välkommen tillbaka.
        </h1>
        <p className="text-[#52525B] text-sm mt-2 font-body">
          Logga in med din arbetsmejl för att fortsätta.
        </p>

        <form onSubmit={submit} className="mt-8 flex flex-col gap-4">
          <div>
            <Label className="overline">E-post</Label>
            <Input
              data-testid="login-email"
              type="email"
              autoComplete="email"
              className="input-base mt-1.5"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <Label className="overline">Lösenord</Label>
            <Input
              data-testid="login-password"
              type="password"
              autoComplete="current-password"
              className="input-base mt-1.5"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && (
            <div
              data-testid="login-error"
              className="text-[13px] text-[#7F1D1D] bg-[#FEF2F2] border border-[#FECACA] px-3 py-2 rounded font-body"
            >
              {error}
            </div>
          )}

          <button
            data-testid="login-submit"
            type="submit"
            disabled={loading}
            className="btn-primary mt-2 inline-flex items-center justify-center gap-2"
          >
            <SignIn size={14} weight="bold" />
            {loading ? "Loggar in…" : "Logga in"}
          </button>
        </form>

        <p className="mt-8 text-[12px] text-[#A1A1AA] font-body">
          Glömt lösenord? Kontakta din admin för återställning.
        </p>
      </div>
    </div>
  );
}
