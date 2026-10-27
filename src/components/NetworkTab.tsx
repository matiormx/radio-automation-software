import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface NetIface {
  name: string;
  kind: "ethernet" | "wifi";
  mac: string;
  up: boolean;
  addresses: string[];
  gateway: string;
  ssid: string;
}
interface IfaceCfg {
  name: string;
  mode: "dhcp" | "static";
  address?: string;
  gateway?: string;
  dns?: string[];
  ssid?: string;
  wifiPassword?: string;
  hasWifiPassword?: boolean;
}
interface NetStatus {
  supported: boolean;
  hostname?: string;
  interfaces?: NetIface[];
  dns?: string[];
  config?: { hostname?: string; interfaces?: IfaceCfg[] } | null;
  pending?: boolean;
  wifiSupport?: boolean;
  admins?: string[];
}

/** Formulario de una interfaz (la máscara se escribe aparte). */
interface Form {
  name: string;
  kind: "ethernet" | "wifi";
  mode: "dhcp" | "static";
  ip: string;
  mask: string;
  gateway: string;
  dns: string;
  ssid: string;
  wifiPassword: string;
  hasWifiPassword: boolean;
}

function maskToPrefix(m: string): number | null {
  const t = m.trim().replace(/^\//, "");
  if (/^\d{1,2}$/.test(t)) {
    const n = Number(t);
    return n >= 1 && n <= 31 ? n : null;
  }
  const parts = t.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !(p >= 0 && p <= 255))) return null;
  const bits = parts.map((p) => p.toString(2).padStart(8, "0")).join("");
  if (!/^1+0*$/.test(bits)) return null;
  const n = bits.indexOf("0") === -1 ? 32 : bits.indexOf("0");
  return n >= 1 && n <= 31 ? n : null;
}
function prefixToMask(p: number): string {
  const bits = "1".repeat(p).padEnd(32, "0");
  return [0, 8, 16, 24].map((i) => parseInt(bits.slice(i, i + 8), 2)).join(".");
}

function toForm(i: NetIface, saved: IfaceCfg | undefined): Form {
  const cur = i.addresses[0] ?? "";
  const [ip, pre] = (saved?.mode === "static" && saved.address ? saved.address : cur).split("/");
  return {
    name: i.name,
    kind: i.kind,
    mode: saved?.mode ?? "dhcp",
    ip: ip ?? "",
    mask: pre ? prefixToMask(Number(pre)) : "255.255.255.0",
    gateway: saved?.mode === "static" ? saved.gateway ?? "" : i.gateway,
    dns: (saved?.dns ?? []).join(", "),
    ssid: saved?.ssid ?? i.ssid,
    wifiPassword: "",
    hasWifiPassword: !!saved?.hasWifiPassword,
  };
}

interface Props {
  showToast: (msg: string) => void;
}

/**
 * Linux (quiosco): red del equipo. Cambiarla pide la contraseña de un
 * administrador, y si no se confirma en 2 minutos vuelve sola a la anterior.
 */
export function NetworkTab({ showToast }: Props) {
  const [st, setSt] = useState<NetStatus | null>(null);
  const [error, setError] = useState("");
  const [forms, setForms] = useState<Form[]>([]);
  const [hostname, setHostname] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const loaded = useRef(false);

  const refresh = useCallback(() => {
    invoke<NetStatus>("net_status")
      .then((s) => {
        setSt(s);
        setError("");
        if (!loaded.current && s.supported) {
          loaded.current = true;
          setHostname(s.hostname ?? "");
          setForms((s.interfaces ?? []).map((i) => toForm(i, s.config?.interfaces?.find((c) => c.name === i.name))));
        }
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 5000);
    return () => window.clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (countdown <= 0) return;
    const t = window.setTimeout(() => {
      if (countdown === 1) loaded.current = false; // se ha deshecho: volver a leer
      setCountdown((c) => (c > 1 ? c - 1 : 0));
    }, 1000);
    return () => window.clearTimeout(t);
  }, [countdown]);

  const patch = (name: string, p: Partial<Form>) => setForms((fs) => fs.map((f) => (f.name === name ? { ...f, ...p } : f)));

  const apply = async () => {
    const interfaces: IfaceCfg[] = [];
    for (const f of forms) {
      const dns = f.dns.split(/[\s,;]+/).filter(Boolean);
      const c: IfaceCfg = { name: f.name, mode: f.mode, dns };
      if (f.mode === "static") {
        const p = maskToPrefix(f.mask);
        if (!f.ip.trim()) return showToast(`${f.name}: falta la dirección IP`);
        if (p === null) return showToast(`${f.name}: máscara no válida (por ejemplo 255.255.255.0)`);
        c.address = `${f.ip.trim()}/${p}`;
        c.gateway = f.gateway.trim();
      }
      if (f.kind === "wifi") {
        c.ssid = f.ssid.trim();
        if (f.wifiPassword) c.wifiPassword = f.wifiPassword;
      }
      interfaces.push(c);
    }
    setBusy(true);
    try {
      const secs = await invoke<number>("net_apply", { config: { hostname, interfaces }, password });
      setPassword("");
      setCountdown(secs);
      showToast("Red cambiada. Confirma que sigue funcionando.");
    } catch (e) {
      showToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const keep = async () => {
    try {
      await invoke("net_confirm");
      setCountdown(0);
      showToast("Configuración de red guardada");
      refresh();
    } catch (e) {
      showToast(String(e));
    }
  };
  const undo = async () => {
    try {
      await invoke("net_revert");
      setCountdown(0);
      loaded.current = false;
      showToast("Vuelta a la configuración anterior");
      refresh();
    } catch (e) {
      showToast(String(e));
    }
  };

  if (error && !st) return <p className="hint update-error">{error}</p>;
  if (!st) return <p className="hint">Comprobando…</p>;
  if (!st.supported) return <p className="hint">La red se configura aquí solo en Linux (equipo de quiosco).</p>;

  return (
    <>
      {(countdown > 0 || st.pending) && (
        <div className="net-pending">
          <strong>¿Sigue funcionando la conexión?</strong>
          <span>
            {countdown > 0
              ? `Si no confirmas en ${countdown} s, el equipo vuelve solo a la configuración anterior.`
              : "Hay un cambio de red sin confirmar; si no lo confirmas, se deshará solo."}
          </span>
          <div className="update-actions">
            <button type="button" className="btn btn-sm btn-accent" onClick={() => void keep()}>
              Mantener
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void undo()}>
              Deshacer ya
            </button>
          </div>
        </div>
      )}

      <fieldset className="fieldset">
        <legend>Equipo</legend>
        <label className="field">
          <span className="field-label">Nombre en la red</span>
          <input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="omnicaster" />
        </label>
        <p className="hint">
          Solo letras, números y guiones. DNS en uso:{" "}
          {st.dns?.length ? st.dns.join(", ") : "—"}
        </p>
      </fieldset>

      {forms.map((f) => {
        const live = st.interfaces?.find((i) => i.name === f.name);
        return (
          <fieldset key={f.name} className="fieldset">
            <legend>
              {f.kind === "wifi" ? "Wi-Fi" : "Cable"} · {f.name}
            </legend>
            <p className="hint">
              {live?.up ? "Conectado" : "Sin conexión"}
              {live?.addresses.length ? ` · IP ${live.addresses.join(", ")}` : ""}
              {live?.gateway ? ` · puerta de enlace ${live.gateway}` : ""}
              {live?.ssid ? ` · red «${live.ssid}»` : ""} · MAC {live?.mac}
            </p>
            {f.kind === "wifi" && (
              <>
                {!st.wifiSupport && <p className="hint update-error">Falta el soporte de Wi-Fi: vuelve a ejecutar el instalador del quiosco.</p>}
                <label className="field">
                  <span className="field-label">Red (SSID)</span>
                  <input value={f.ssid} onChange={(e) => patch(f.name, { ssid: e.target.value })} placeholder="Vacío = no usar el Wi-Fi" />
                </label>
                <label className="field">
                  <span className="field-label">Contraseña del Wi-Fi</span>
                  <input
                    type="password"
                    value={f.wifiPassword}
                    onChange={(e) => patch(f.name, { wifiPassword: e.target.value })}
                    placeholder={f.hasWifiPassword ? "(sin cambios)" : "Vacía si la red es abierta"}
                  />
                </label>
              </>
            )}
            <label className="field">
              <span className="field-label">Dirección IP</span>
              <select value={f.mode} onChange={(e) => patch(f.name, { mode: e.target.value as Form["mode"] })}>
                <option value="dhcp">Automática (DHCP)</option>
                <option value="static">Fija</option>
              </select>
            </label>
            {f.mode === "static" && (
              <div className="net-grid">
                <label className="field">
                  <span className="field-label">IP</span>
                  <input value={f.ip} onChange={(e) => patch(f.name, { ip: e.target.value })} placeholder="192.168.1.50" />
                </label>
                <label className="field">
                  <span className="field-label">Máscara</span>
                  <input value={f.mask} onChange={(e) => patch(f.name, { mask: e.target.value })} placeholder="255.255.255.0" />
                </label>
                <label className="field">
                  <span className="field-label">Puerta de enlace</span>
                  <input value={f.gateway} onChange={(e) => patch(f.name, { gateway: e.target.value })} placeholder="192.168.1.1" />
                </label>
              </div>
            )}
            <label className="field">
              <span className="field-label">DNS {f.mode === "dhcp" ? "(vacío = los del router)" : ""}</span>
              <input value={f.dns} onChange={(e) => patch(f.name, { dns: e.target.value })} placeholder="1.1.1.1, 8.8.8.8" />
            </label>
          </fieldset>
        );
      })}

      <fieldset className="fieldset">
        <legend>Aplicar cambios</legend>
        <p className="hint">
          Hace falta la contraseña de un administrador del equipo{st.admins?.length ? ` (${st.admins.join(", ")})` : ""}, no
          la del usuario radio. Si después de aplicar no confirmas en 2 minutos, se vuelve sola a la red anterior (por si
          el equipo se queda sin conexión). Si cambias la IP y lo manejas por VNC, vuelve a conectarte a la nueva para
          confirmar.
        </p>
        <label className="field">
          <span className="field-label">Contraseña de administrador</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && password && void apply()}
          />
        </label>
        <div className="update-actions">
          <button type="button" className="btn btn-sm btn-accent" disabled={busy || !password || countdown > 0} onClick={() => void apply()}>
            {busy ? "Aplicando…" : "Aplicar"}
          </button>
        </div>
        {error && <p className="hint update-error">{error}</p>}
      </fieldset>
    </>
  );
}
