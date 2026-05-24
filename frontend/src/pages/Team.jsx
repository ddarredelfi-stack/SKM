import { useEffect, useState } from "react";
import { Plus, Trash, Crown, User as UserIcon, Shield } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useAuth, formatApiError } from "../lib/auth";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { formatDate } from "../lib/api";

const empty = { email: "", name: "", password: "", role: "member" };

export default function Team() {
  const { user } = useAuth();
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const isAdmin = user?.role === "admin";

  const load = async () => {
    const res = await api.get("/users");
    setUsers(res.data.items || []);
  };
  useEffect(() => { load(); }, []);

  const create = async (e) => {
    e.preventDefault();
    if (!form.email || !form.name || !form.password) {
      toast.error("E-post, namn och lösenord krävs");
      return;
    }
    setBusy(true);
    try {
      await api.post("/users", form);
      toast.success(`Användare ${form.name} skapad`);
      setForm(empty);
      load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || err.message);
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (u, newRole) => {
    try {
      await api.patch(`/users/${u.id}`, { role: newRole });
      toast.success(`${u.name} är nu ${newRole}`);
      load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || err.message);
    }
  };

  const remove = async (u) => {
    if (!confirm(`Ta bort ${u.name}? Deras prospekt blir otilldelade.`)) return;
    try {
      await api.delete(`/users/${u.id}`);
      toast.success(`${u.name} borttagen`);
      load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || err.message);
    }
  };

  return (
    <div data-testid="team-page" className="flex flex-col gap-6">
      <header>
        <div className="overline">Team</div>
        <h1 className="font-display font-extrabold tracking-tighter text-4xl mt-1">
          Mitt team
        </h1>
        <p className="text-[#52525B] text-sm mt-2 font-body max-w-2xl">
          {users.length} användare. {isAdmin
            ? "Du kan bjuda in kollegor och ändra roller."
            : "Endast admin kan bjuda in nya användare."}
        </p>
      </header>

      {isAdmin && (
        <section className="card-surface p-5">
          <div className="overline mb-3">Bjud in kollega</div>
          <form onSubmit={create} className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <Input
              data-testid="invite-name"
              placeholder="Namn"
              className="input-base"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Input
              data-testid="invite-email"
              type="email"
              placeholder="E-post"
              className="input-base md:col-span-2"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <Input
              data-testid="invite-password"
              type="text"
              placeholder="Tillfälligt lösenord"
              className="input-base"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
              <SelectTrigger data-testid="invite-role" className="input-base">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Medlem</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
            <button
              data-testid="invite-submit"
              type="submit"
              disabled={busy}
              className="btn-primary inline-flex items-center justify-center gap-1.5 md:col-span-5"
            >
              <Plus size={14} /> {busy ? "Skapar…" : "Skapa konto"}
            </button>
          </form>
          <p className="mt-3 text-[11px] text-[#A1A1AA] font-body">
            Det tillfälliga lösenordet behöver du dela manuellt med kollegan. De kan byta det själva
            (kommer i nästa version) eller be dig återställa det.
          </p>
        </section>
      )}

      <div className="card-surface overflow-hidden">
        <Table data-testid="users-table">
          <TableHeader>
            <TableRow className="bg-[#FAFAFA]">
              <TableHead className="overline">Namn</TableHead>
              <TableHead className="overline">E-post</TableHead>
              <TableHead className="overline">Roll</TableHead>
              <TableHead className="overline">Skapad</TableHead>
              <TableHead className="overline w-20"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id} className="row-hover" data-testid={`user-row-${u.id}`}>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-full bg-[#F4F4F5] border border-[#E5E5E5] flex items-center justify-center">
                      {u.role === "admin" ? (
                        <Crown size={14} color="#CBA135" weight="duotone" />
                      ) : (
                        <UserIcon size={14} color="#52525B" />
                      )}
                    </div>
                    <div className="font-display font-bold text-sm">
                      {u.name}
                      {u.id === user?.id && (
                        <span className="ml-2 text-[10px] uppercase tracking-wider text-[#CBA135] font-display font-bold">
                          (du)
                        </span>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-sm font-body text-[#52525B]">{u.email}</TableCell>
                <TableCell>
                  {isAdmin && u.id !== user?.id ? (
                    <Select value={u.role} onValueChange={(v) => changeRole(u, v)}>
                      <SelectTrigger className="input-base !p-1.5 h-auto w-32 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">Medlem</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <span
                      className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-display font-bold px-2 py-0.5 rounded"
                      style={{
                        background: u.role === "admin" ? "#0A0A0A" : "#F4F4F5",
                        color: u.role === "admin" ? "#CBA135" : "#52525B",
                      }}
                    >
                      <Shield size={10} weight="duotone" /> {u.role}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-sm font-body text-[#52525B]">{formatDate(u.created_at)}</TableCell>
                <TableCell>
                  {isAdmin && u.id !== user?.id && (
                    <button
                      onClick={() => remove(u)}
                      className="btn-ghost p-1.5 text-[#DC2626]"
                      data-testid={`delete-user-${u.id}`}
                    >
                      <Trash size={14} />
                    </button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!users.length && (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-12 text-[#A1A1AA] text-sm">
                  Inga användare hittade.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
