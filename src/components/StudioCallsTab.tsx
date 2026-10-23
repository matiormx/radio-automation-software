import { useState } from "react";
import type { Settings, StudioCallsSettings } from "../types";
import { DEFAULT_SETTINGS } from "../types";
import { studioSocketUrl, type StudioSnapshot } from "../studioCalls";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  studio: StudioSnapshot;
  callMuted: boolean;
  onCallMute: (muted: boolean) => void;
}

const STATUS_TEXT: Record<StudioSnapshot["status"], string> = {
  off: "Desconectado",
  connecting: "Conectando con NGRADIO…",
  online: "Conectado a NGRADIO",
  error: "Error de conexión",
};

export function StudioCallsTab({ settings, onChange, studio, callMuted, onCallMute }: Props) {
  const cfg = settings.studioCalls;
  const set = (patch: Partial<StudioCallsSettings>) =>
    onChange({ ...settings, studioCalls: { ...cfg, ...patch } });
  const chat = settings.chat ?? DEFAULT_SETTINGS.chat;
  const setChat = (patch: Partial<typeof chat>) => onChange({ ...settings, chat: { ...chat, ...patch } });
  const urlOk = studioSocketUrl(cfg.serverUrl) !== null;
  const tokenOk = cfg.token.trim().length >= 24;
  // Los datos de conexion son delicados: bloqueados hasta que se confirme.
  const [locked, setLocked] = useState(true);
  const [warn, setWarn] = useState(false);

  return (
    <>
      <div className="camp-head">
        <div>
          <h4>Llamadas al aire</h4>
          <p className="hint">
            Recibe aquí las llamadas que el moderador pasa al aire desde NGRADIO. La voz del
            oyente entra en la mesa como el canal «Llamadas de oyentes» y él oye el programa sin
            su propia voz. Las llamadas se atienden y se pasan al aire desde el panel de NGRADIO.
          </p>
        </div>
      </div>

      <fieldset className="fieldset" disabled={locked}>
        <legend>
          Conexión{" "}
          <button
            type="button"
            className="ghost-btn"
            style={{ pointerEvents: "auto" }}
            title={locked ? "Desbloquear" : "Bloquear"}
            aria-label={locked ? "Desbloquear los ajustes de conexión" : "Bloquear los ajustes de conexión"}
            aria-pressed={!locked}
            onClick={() => {
              if (locked) setWarn(true);
              else setLocked(true);
            }}
          >
            {locked ? "🔒" : "🔓"}
          </button>
        </legend>
        {warn && locked && (
          <div className="form-error" role="alertdialog" style={{ pointerEvents: "auto" }}>
            <p>
              <strong>Parámetro delicado.</strong> La dirección y el token de estudio son los que dan acceso a las
              llamadas de NGRADIO. Un valor incorrecto cortará las llamadas o expondrá el acceso. ¿Quieres editarlos?
            </p>
            <div className="field-row">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setLocked(false);
                  setWarn(false);
                }}
              >
                Sí, desbloquear
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setWarn(false)}>
                Cancelar
              </button>
            </div>
          </div>
        )}
        <label className="check-row">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          <span>Recibir llamadas al aire</span>
        </label>
        <label className="field">
          <span>Dirección de NGRADIO</span>
          <input
            type="text"
            value={cfg.serverUrl}
            placeholder="https://app.ngradio.es"
            spellCheck={false}
            onChange={(e) => set({ serverUrl: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Token de estudio</span>
          <input
            type="password"
            value={cfg.token}
            placeholder="El secreto STUDIO_TOKEN del worker"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => set({ token: e.target.value })}
          />
        </label>
        {cfg.enabled && (!urlOk || !tokenOk) && (
          <p className="form-error">
            {!urlOk ? "La dirección no es válida." : "El token debe tener al menos 24 caracteres."}
          </p>
        )}
        <p className="hint">
          Estado: <strong>{STATUS_TEXT[studio.status]}</strong>
          {studio.error ? ` — ${studio.error}` : ""}
        </p>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Chat de NGRADIO</legend>
        <label className="check-row">
          <input
            type="checkbox"
            checked={chat.enabled}
            onChange={(e) => setChat({ enabled: e.target.checked })}
          />
          <span>Mostrar el chat de los oyentes en MiRadio</span>
        </label>
        <label className="field">
          <span>Nombre con el que escribe la emisora</span>
          <input
            type="text"
            maxLength={40}
            value={chat.name}
            placeholder={settings.radioName || "Estudio"}
            onChange={(e) => setChat({ name: e.target.value })}
          />
        </label>
        <label className="check-row">
          <input type="checkbox" checked={chat.floating} onChange={(e) => setChat({ floating: e.target.checked })} />
          <span>En una ventana flotante (si no, acoplado bajo la lista de emisión)</span>
        </label>
        <p className="hint">
          Usa la misma dirección y token de estudio que las llamadas. Desde MiRadio escribes como la emisora y puedes
          borrar mensajes o silenciar a un oyente (como un moderador).
        </p>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Ahora en el aire</legend>
        {studio.calls.length === 0 ? (
          <p className="hint">Ninguna llamada al aire.</p>
        ) : (
          <>
            <ul className="studio-calls">
              {studio.calls.map((c) => (
                <li key={c.id}>{c.name}</li>
              ))}
            </ul>
            <button type="button" className="btn btn-sm" onClick={() => onCallMute(!callMuted)}>
              {callMuted ? "Dar voz al oyente" : "Silenciar al oyente"}
            </button>
          </>
        )}
        <p className="hint">
          En la pestaña Sonido puedes elegir «Llamadas de oyentes» como entrada de un canal para
          darle su propio fader, bus y salida. Sin canal propio, la voz sale por la salida del
          sistema junto al resto del programa.
        </p>
      </fieldset>
    </>
  );
}
