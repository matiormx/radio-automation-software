import { useCallback, useEffect, useState } from "react";
import { aiEnrichStart, aiEnrichStatus, aiEnrichStop, aiModels, aiOpencodeVersion, type AiEnrichStatus } from "../api";
import { DEFAULT_SETTINGS, type AiSettings, type Settings } from "../types";
import { Help } from "./Help";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  showToast: (msg: string) => void;
}

/** Servicios con preset: se elige y solo queda pegar la clave. */
const CLOUD_SERVICES: Array<{ id: string; label: string; url: string; hint: string; model: string }> = [
  { id: "zen", label: "OpenCode Zen (por uso)", url: "https://opencode.ai/inference/openai/v1", hint: "glm-5.3-flash, kimi-k3, qwen3.8…", model: "glm-5.3-flash" },
  { id: "ocgo", label: "OpenCode Go (suscripción)", url: "https://opencode.ai/inference/go/openai/v1", hint: "los mismos Zen con tu plan Go", model: "glm-5.3-flash" },
  { id: "openrouter", label: "OpenRouter (modelos gratis)", url: "https://openrouter.ai/api/v1", hint: "modelos …:free de varios proveedores", model: "meta-llama/llama-3.3-70b-instruct:free" },
  { id: "groq", label: "Groq (gratis)", url: "https://api.groq.com/openai/v1", hint: "llama-3.3-70b-versatile", model: "llama-3.3-70b-versatile" },
  { id: "gemini", label: "Gemini (gratis)", url: "https://generativelanguage.googleapis.com/v1beta/openai", hint: "gemini-2.5-flash", model: "gemini-2.5-flash" },
  { id: "cerebras", label: "Cerebras (gratis, rapidísimo)", url: "https://api.cerebras.ai/v1", hint: "llama-3.3-70b y amigos", model: "llama-3.3-70b" },
  { id: "mistral", label: "Mistral (capa gratuita)", url: "https://api.mistral.ai/v1", hint: "mistral-small-latest", model: "mistral-small-latest" },
  { id: "deepseek", label: "DeepSeek (muy barato)", url: "https://api.deepseek.com/v1", hint: "deepseek-chat", model: "deepseek-chat" },
  { id: "openai", label: "OpenAI", url: "https://api.openai.com/v1", hint: "gpt-4o-mini", model: "gpt-4o-mini" },
  { id: "custom", label: "Otro servicio", url: "", hint: "", model: "" },
];

function serviceIdOf(url: string | undefined): string {
  const u = (url ?? "").toLowerCase();
  if (u.includes("opencode.ai/inference/go")) return "ocgo";
  if (u.includes("opencode.ai")) return "zen";
  if (u.includes("api.openai.com")) return "openai";
  if (u.includes("api.groq.com")) return "groq";
  if (u.includes("generativelanguage.googleapis.com")) return "gemini";
  if (!u) return "openai";
  return "custom";
}

/**
 * Ajustes > IA: motor de analisis local (Ollama u OpenCode). El analisis solo
 * envia los metadatos de la ficha; el audio no sale del equipo.
 */
export function AiTab({ settings, onChange, showToast }: Props) {
  const ai = settings.ai ?? DEFAULT_SETTINGS.ai;
  const provider =
    ai.provider === "opencode" || ai.provider === "cloud" ? ai.provider : "ollama";
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // La lista de modelos se pide sola al proveedor (sin toasts): el campo de
  // modelo pasa a ser una lista, no algo que escribir a mano.
  const fetchModels = useCallback((quiet = true) => {
    void aiModels({ ...ai, provider })
      .then((list) => setModels(list))
      .catch(() => setModels([]));
    void quiet;
  }, [ai, provider]);
  useEffect(() => {
    const t = window.setTimeout(() => fetchModels(), 500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    provider,
    ai.url,
    ai.opencodePath,
    ai.cloudUrl,
    ai.cloudKey,
    ai.model && provider === "ollama" ? ai.model : "",
  ]);

  const setAi = (patch: Partial<typeof ai>) => {
    onChange({ ...settings, ai: { ...ai, ...patch } });
  };

  const testOllama = async () => {
    setBusy(true);
    setError("");
    try {
      const list = await aiModels({ ...ai, provider: "ollama" });
      setModels(list);
      if (list.length === 0) {
        setError("Ollama responde, pero no tiene modelos instalados. Prueba con: ollama pull llama3.1:8b");
      } else {
        showToast(`Ollama conectado · ${list.length} modelo${list.length === 1 ? "" : "s"}`);
      }
    } catch (e) {
      setModels([]);
      setError(String(e));
      showToast("No se pudo conectar con Ollama");
    } finally {
      setBusy(false);
    }
  };

  const testOpencode = async () => {
    setBusy(true);
    setError("");
    setModels([]);
    try {
      const version = await aiOpencodeVersion(ai.opencodePath ?? "");
      const list = await aiModels({ ...ai, provider: "opencode" });
      setModels(list);
      showToast(
        `OpenCode ${version} · ${list.length} modelo${list.length === 1 ? "" : "s"}`,
      );
    } catch (e) {
      setModels([]);
      setError(String(e));
      showToast("No se pudo comprobar OpenCode");
    } finally {
      setBusy(false);
    }
  };

  const testCloud = async () => {
    setBusy(true);
    setError("");
    setModels([]);
    try {
      const list = await aiModels({ ...ai, provider: "cloud" });
      setModels(list);
      showToast(
        `Conectado · ${list.length} modelo${list.length === 1 ? "" : "s"}`,
      );
    } catch (e) {
      setModels([]);
      setError(String(e));
      showToast("No se pudo conectar con el servicio de IA");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <fieldset className="fieldset">
        <legend>Funciones de IA en este equipo</legend>
        <label className="check-field">
          <input type="checkbox" checked={!!ai.enabled} onChange={(e) => setAi({ enabled: e.target.checked })} />
          Activar el asistente de canciones, los metadatos IA de la biblioteca y la escucha del directo
        </label>
        <Help>
          Apagado de serie: consumen recursos. Los metadatos ya generados siguen sirviendo al AutoDJ aunque esté
          apagado, y el asistente de la nube (cloud.ngradio.es/asistente) funciona sin este equipo. El análisis
          de metadatos de abajo (botón de IA en el editor de pistas) funciona siempre.
        </Help>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Motor de IA</legend>
        <label className="field">
          <span className="field-label">Motor</span>
          <select
            value={provider}
            onChange={(e) => {
              setModels([]);
              setError("");
              setAi({ provider: e.target.value as typeof ai.provider });
            }}
          >
            <option value="ollama">Ollama (en este equipo o en la red)</option>
            <option value="opencode">OpenCode (programa instalado)</option>
            <option value="cloud">Servicio en la nube</option>
          </select>
        </label>
        {provider === "cloud" && (
          <>
            <Help>
              La IA propone idioma, estilo, etiquetas, energía, mood y temas a partir de los datos de
              cada canción (título, artista, álbum, año, estilo y letra si la hay). No se sube el
              audio. Vale OpenCode, OpenRouter, Groq, Gemini, OpenAI…
            </Help>
            <div className="field-row">
              <label className="field">
                <span className="field-label">Servicio</span>
                <select
                  value={serviceIdOf(ai.cloudUrl)}
                  onChange={(e) => {
                    const preset = CLOUD_SERVICES.find((x) => x.id === e.target.value);
                    if (preset?.url) {
                      setModels([]);
                      setAi({ cloudUrl: preset.url, cloudModel: preset.model || preset.hint.split(" ")[0] });
                    }
                    if (e.target.value === "custom") setAi({ cloudUrl: "" });
                  }}
                >
                  {CLOUD_SERVICES.map((x) => (
                    <option key={x.id} value={x.id}>{x.label}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Clave (API key)</span>
                <input
                  type="password"
                  value={ai.cloudKey ?? ""}
                  spellCheck={false}
                  placeholder="Pega tu clave aquí"
                  onChange={(e) => setAi({ cloudKey: e.target.value })}
                />
              </label>
            </div>
            {serviceIdOf(ai.cloudUrl) === "custom" && (
              <label className="field">
                <span className="field-label">Dirección del servicio</span>
                <input
                  type="text"
                  value={ai.cloudUrl ?? ""}
                  spellCheck={false}
                  placeholder="https://…/v1"
                  onChange={(e) => setAi({ cloudUrl: e.target.value })}
                />
              </label>
            )}
            <div className="field-row">
              <label className="field">
                <span className="field-label">Modelo</span>
                <ModelSelect
                  value={ai.cloudModel ?? ""}
                  models={models}
                  placeholder={CLOUD_SERVICES.find((x) => x.id === serviceIdOf(ai.cloudUrl))?.hint || "gpt-4o-mini"}
                  onChange={(model) => setAi({ cloudModel: model })}
                />
              </label>
            </div>
            <div className="update-actions">
              <button type="button" className="btn btn-sm" onClick={() => void testCloud()} disabled={busy}>
                {busy ? "Probando…" : "Probar conexión"}
              </button>
              {models.length > 0 && (
                <span className="hint">
                  {models.length} modelo{models.length === 1 ? "" : "s"} disponible
                  {models.length === 1 ? "" : "s"}: {models.slice(0, 4).join(", ")}
                  {models.length > 4 ? "…" : ""}
                </span>
              )}
            </div>
            {error && <div className="form-error">{error}</div>}
          </>
        )}
        {provider === "ollama" && (
          <>
            <Help>
              Usa un servidor <strong>Ollama</strong> en tu equipo para proponer idioma, estilo y
              etiquetas a partir de los metadatos de cada canción. No se sube el audio: solo se
              envían título, artista, álbum, año, estilo, etiquetas y nombre del archivo. Las
              propuestas se revisan y se aceptan una a una antes de guardarlas.
            </Help>
            <div className="field-row">
              <label className="field">
                <span className="field-label">Dirección de Ollama</span>
                <input
                  type="text"
                  value={ai.url}
                  spellCheck={false}
                  placeholder="http://127.0.0.1:11434"
                  onChange={(e) => setAi({ url: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label">Modelo</span>
                <ModelSelect
                  value={ai.model}
                  models={models}
                  placeholder="llama3.1:8b"
                  onChange={(model) => setAi({ model })}
                />
              </label>
            </div>
            <div className="update-actions">
              <button type="button" className="btn btn-sm" onClick={() => void testOllama()} disabled={busy}>
                {busy ? "Probando…" : "Probar conexión"}
              </button>
              {models.length > 0 && (
                <span className="hint">
                  {models.length} modelo{models.length === 1 ? "" : "s"} disponible
                  {models.length === 1 ? "" : "s"}: {models.slice(0, 4).join(", ")}
                  {models.length > 4 ? "…" : ""}
                </span>
              )}
            </div>
            {error && <div className="form-error">{error}</div>}
          </>
        )}
        {provider === "opencode" && (
          <>
            <Help>
              Usa <strong>OpenCode</strong> instalado en tu equipo: cada análisis lanza
              <code> opencode run</code> con una orden breve. No se sube el audio: solo se envían
              título, artista, álbum, año, estilo, etiquetas y nombre del archivo. Las propuestas
              se revisan y se aceptan una a una antes de guardarlas. Configura primero tu
              proveedor con <code>opencode auth login</code>.
            </Help>
            <div className="field-row">
              <label className="field">
                <span className="field-label">Comando OpenCode</span>
                <input
                  type="text"
                  value={ai.opencodePath ?? ""}
                  spellCheck={false}
                  placeholder="opencode"
                  onChange={(e) => setAi({ opencodePath: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label">Modelo</span>
                <ModelSelect
                  value={ai.model}
                  models={models}
                  placeholder="(el que tenga OpenCode por defecto)"
                  onChange={(model) => setAi({ model })}
                />
              </label>
            </div>
            <div className="update-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void testOpencode()}
                disabled={busy}
              >
                {busy ? "Probando…" : "Probar OpenCode"}
              </button>
              {models.length > 0 && (
                <span className="hint">
                  {models.length} modelo{models.length === 1 ? "" : "s"} disponible
                  {models.length === 1 ? "" : "s"}: {models.slice(0, 4).join(", ")}
                  {models.length > 4 ? "…" : ""}
                </span>
              )}
            </div>
            {error && <div className="form-error">{error}</div>}
          </>
        )}
      </fieldset>

      {ai.enabled && (
        <>
      <EnrichBox ai={{ ...ai, provider }} enrichAuto={!!ai.enrichAuto} setAuto={(v) => setAi({ enrichAuto: v })} showToast={showToast} />

      <fieldset className="fieldset">
        <legend>Asistente de canciones</legend>
        <Help>
          En la barra de arriba, el botón <strong>«IA»</strong> abre un chat: pide lo que quieres
          sonar («algo tranquilo sobre la esperanza, en español») y propone canciones de tu
          biblioteca que no hayan sonado hace poco, con un clic para ponerlas de siguiente.
        </Help>
        <label className="check-field">
          <input
            type="checkbox"
            checked={!!ai.listenLive}
            onChange={(e) => setAi({ listenLive: e.target.checked })}
          />
          Escuchar el directo para que el asistente sepa de qué se está hablando
        </label>
        <Help>
          Mientras el directo está activo, cada medio minuto se pasa a texto lo que sale al aire
          (Whisper, en este equipo; el audio no sale de él). Al terminar el directo, el asistente
          propone canciones según lo hablado.
        </Help>
        <Help>
          Para que solo oiga las voces: en la Consola, manda los micrófonos a un bus (con un envío) y añade a ese
          bus la salida <strong>«IA (Whisper)»</strong>. Si algo va a esa salida, la IA oye solo eso en lugar de lo
          que sale al aire, y la música no se mezcla en la transcripción.
        </Help>
        {ai.listenLive && (
          <p className="form-error">
            ⚠ Gasta bastante procesador: en equipos de 4 núcleos con vídeo o muchos plugins puede
            provocar cortes. Funciona a prioridad mínima, pero si notas el audio entrecortado,
            desactívalo. La primera vez descarga el modelo de voz (~142 MB).
          </p>
        )}
      </fieldset>
        </>
      )}

      {provider === "cloud" ? (
        // Ayuda plegada: solo se abre sola si aún no hay clave.
        <details className="fieldset ai-help" open={!(ai.cloudKey ?? "").trim()}>
          <summary>¿Dónde consigo una clave (API key)?</summary>
          <p className="hint">Crea una clave en uno de estos servicios y pégala arriba en «Clave»:</p>
          <ul className="ai-help-list">
            <li><strong>OpenRouter</strong> — openrouter.ai/keys (los modelos «:free» no cuestan nada)</li>
            <li><strong>Groq</strong> — console.groq.com/keys (gratis)</li>
            <li><strong>Gemini</strong> — aistudio.google.com (gratis)</li>
            <li><strong>Cerebras</strong> — cloud.cerebras.ai/keys</li>
            <li><strong>Mistral</strong> — console.mistral.ai</li>
            <li><strong>OpenCode Go/Zen</strong> — opencode.ai (con <code>glm-5.3-flash</code> cuesta céntimos por miles de canciones; los modelos «-free» de Zen no funcionan fuera de OpenCode)</li>
            <li><strong>DeepSeek</strong> — platform.deepseek.com</li>
            <li><strong>OpenAI</strong> — platform.openai.com/api-keys</li>
          </ul>
          <Help>
            Después pulsa «Probar conexión»: se llena la lista de modelos y eliges uno. Solo se envían los datos de
            texto de cada canción (título, artista, letra…), nunca el audio.
          </Help>
        </details>
      ) : provider === "ollama" ? (
        <fieldset className="fieldset">
          <legend>Cómo preparar Ollama</legend>
          <p className="hint">
            Instala Ollama desde <strong>ollama.com</strong> y descarga un modelo, por ejemplo:
          </p>
          <pre className="ai-command">ollama pull llama3.1:8b</pre>
          <Help>
            Si Ollama está en otro equipo o usa otro puerto, cambia la dirección. El análisis
            puede tardar unos segundos por canción según el modelo y el hardware.
          </Help>
        </fieldset>
      ) : (
        <fieldset className="fieldset">
          <legend>Cómo preparar OpenCode</legend>
          <Help>
            Instala OpenCode (<strong>curl -fsSL https://opencode.ai/install | bash</strong> o
            npm) y entra a tu proveedor una sola vez:
          </Help>
          <pre className="ai-command">opencode auth login</pre>
          <Help>
            El modelo se escribe como <strong>proveedor/modelo</strong> (con <code>opencode
            models</code> ves la lista: por ejemplo <code>openai/gpt-5.2</code>). Vacío usa el
            modelo por defecto de tu OpenCode. Cada análisis es un <code>opencode run</code>
            corto: el resultado llega con el JSON que la app espera; si el modelo se demora más
            de 4 minutos se cancela.
          </Help>
        </fieldset>
      )}
    </>
  );
}

/** Lista de modelos según lo que ofrece el proveedor (bajo un modo manual). */
function ModelSelect({
  value,
  models,
  placeholder,
  onChange,
}: {
  value: string;
  models: string[];
  placeholder: string;
  onChange: (model: string) => void;
}) {
  const options = [...new Set([...models, value].filter(Boolean))];
  const manual = value !== "" && !models.includes(value);
  const [writing, setWriting] = useState(manual && models.length === 0);
  if (writing) {
    return (
      <div style={{ display: "flex", gap: 6 }}>
        <input
          type="text"
          value={value}
          spellCheck={false}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" className="btn btn-sm" onClick={() => setWriting(false)}>
          Lista
        </button>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 6 }}>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Modelo">
        {value === "" && <option value="">{placeholder}</option>}
        {options.map((model) => (
          <option key={model} value={model}>
            {value === model && models.length > 0 && !models.includes(model) ? `${model} (el de ahora)` : model}
          </option>
        ))}
      </select>
      <button type="button" className="btn btn-sm" title="Escribir el modelo a mano" onClick={() => setWriting(true)}>
        ✎
      </button>
    </div>
  );
}

/** Metadatos IA de la biblioteca: energía, mood y temas de cada canción. */
function EnrichBox({
  ai,
  enrichAuto,
  setAuto,
  showToast,
}: {
  ai: AiSettings;
  enrichAuto: boolean;
  setAuto: (v: boolean) => void;
  showToast: (m: string) => void;
}) {
  const [st, setSt] = useState<AiEnrichStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => void aiEnrichStatus().then((s) => alive && setSt(s)).catch(() => undefined);
    tick();
    const t = window.setInterval(tick, 4000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);
  const pct = st && st.total > 0 ? Math.round((st.done / st.total) * 100) : 0;
  return (
    <fieldset className="fieldset">
      <legend>Metadatos IA de la biblioteca (energía, mood y temas)</legend>
      <Help>
        La IA describe cada canción: energía del 1 al 5, mood y de qué habla la letra. Las usan el
        AutoDJ (energía del día, en Ajustes › AutoDJ) y el asistente de canciones. Se hace una vez por
        canción, de 10 en 10, y la nube las reparte a los demás equipos: mejor desde un{" "}
        <strong>estación de trabajo</strong>, así el del estudio no gasta nada.
      </Help>
      {st && (
        <p>
          <strong>
            {st.done} de {st.total}
          </strong>{" "}
          canciones con metadatos IA ({pct} %){st.running ? ` · procesando… (${st.session} en esta tanda)` : ""}
        </p>
      )}
      {st?.error && <div className="form-error">{st.error}</div>}
      <p>
        {st?.running ? (
          <button type="button" className="btn btn-sm" onClick={() => void aiEnrichStop().then(() => showToast("Se detendrá al terminar el grupo actual"))}>
            Detener
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-sm btn-accent"
            disabled={!!st && st.done >= st.total}
            onClick={() => void aiEnrichStart(ai).then(setSt).catch((e) => showToast(String(e)))}
          >
            {st && st.done > 0 ? "Seguir con las que faltan" : "Procesar la biblioteca"}
          </button>
        )}
      </p>
      <label className="check-field">
        <input type="checkbox" checked={enrichAuto} onChange={(e) => setAuto(e.target.checked)} />
        Procesar solas las canciones nuevas (en este equipo, cada 30 minutos)
      </label>
    </fieldset>
  );
}
