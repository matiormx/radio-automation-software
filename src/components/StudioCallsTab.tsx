import type { Settings, StudioCallsSettings } from "../types";
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
  const urlOk = studioSocketUrl(cfg.serverUrl) !== null;
  const tokenOk = cfg.token.trim().length >= 24;

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

      <fieldset className="fieldset">
        <legend>Conexión</legend>
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
