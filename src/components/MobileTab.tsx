import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MobileSettings, Settings } from "../types";

interface MobileStatus {
  running: boolean;
  port: number;
  urls: string[];
  error: string | null;
}

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
}

const DEFAULTS: MobileSettings = { enabled: false, port: 8080, pin: "" };

/** Ajustes › Control desde el móvil: activar, PIN, puerto y la dirección a abrir. */
export function MobileTab({ settings, onChange }: Props) {
  const m = { ...DEFAULTS, ...(settings.mobile ?? {}) };
  const [st, setSt] = useState<MobileStatus | null>(null);
  const [pin, setPin] = useState(m.pin);
  const set = (patch: Partial<MobileSettings>) => onChange({ ...settings, mobile: { ...m, ...patch } });

  useEffect(() => setPin(m.pin), [m.pin]);
  useEffect(() => {
    const load = () => void invoke<MobileStatus>("mobile_status").then(setSt).catch(() => undefined);
    load();
    const t = window.setInterval(load, 2000);
    return () => window.clearInterval(t);
  }, []);

  const pinOk = /^\d{4,8}$/.test(pin);
  return (
    <>
      <fieldset className="fieldset">
        <legend>Control desde el móvil</legend>
        <p className="hint">
          Maneja el directo desde el navegador del móvil: lo que suena, la lista, la emisión, la botonera de vídeo y los
          faders de la mesa. Funciona en la red del estudio y desde fuera por WireGuard (no se abre nada a internet). Para
          entrar hace falta el PIN.
        </p>
        <label className="field">
          <span className="field-label">PIN (4 a 8 cifras)</span>
          <input
            value={pin}
            inputMode="numeric"
            maxLength={8}
            placeholder="p. ej. 2580"
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            onBlur={() => pinOk && pin !== m.pin && set({ pin })}
          />
        </label>
        <label className="field">
          <span className="field-label">Puerto</span>
          <input
            type="number"
            min={1024}
            max={65535}
            value={m.port}
            onChange={(e) => set({ port: Math.min(65535, Math.max(1024, Number(e.target.value) || 8080)) })}
          />
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={m.enabled}
            disabled={!m.enabled && !pinOk}
            onChange={(e) => set({ enabled: e.target.checked, pin: pinOk ? pin : m.pin })}
          />
          Activar el control desde el móvil
        </label>
        {!m.enabled && !pinOk && <p className="hint">Pon antes un PIN de 4 a 8 cifras.</p>}
        {st?.error && <p className="hint update-error">{st.error}</p>}
        {m.enabled && st?.running && (
          <div className="mobile-urls">
            <p className="hint">Abre en el navegador del móvil (y añádelo a la pantalla de inicio):</p>
            {st.urls.length === 0 ? (
              <p className="hint">http://IP-de-este-equipo:{st.port}</p>
            ) : (
              st.urls.map((u) => (
                <code key={u} className="mobile-url">
                  {u}
                </code>
              ))
            )}
            <p className="hint">
              Cambiar el PIN cierra la sesión en los móviles que ya entraron. Si Windows pregunta por el cortafuegos,
              permite el acceso en redes privadas.
            </p>
          </div>
        )}
      </fieldset>
    </>
  );
}
