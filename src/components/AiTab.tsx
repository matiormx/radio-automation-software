import { useState } from "react";
import { aiModels, aiOpencodeVersion } from "../api";
import { DEFAULT_SETTINGS, type Settings } from "../types";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  showToast: (msg: string) => void;
}

/** Servicios con preset: se elige y solo queda pegar la clave. */
const CLOUD_SERVICES: Array<{ id: string; label: string; url: string; hint: string }> = [
  { id: "ocgo", label: "OpenCode Go (Zen)", url: "https://opencode.ai/inference/go/openai/v1", hint: "glm-5.3-flash, qwen3.8-flash… (la lista sale al probar)" },
  { id: "openai", label: "OpenAI", url: "https://api.openai.com/v1", hint: "gpt-4o-mini" },
  { id: "groq", label: "Groq (gratis)", url: "https://api.groq.com/openai/v1", hint: "llama-3.3-70b-versatile" },
  { id: "gemini", label: "Gemini (gratis)", url: "https://generativelanguage.googleapis.com/v1beta/openai", hint: "mira la lista al probar" },
  { id: "custom", label: "Otro (compatible OpenAI)", url: "", hint: "" },
];

function serviceIdOf(url: string | undefined): string {
  const u = (url ?? "").toLowerCase();
  if (u.includes("opencode.ai")) return "ocgo";
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
        <legend>Análisis de metadatos con IA local</legend>
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
            <option value="ollama">Ollama (servidor local)</option>
            <option value="opencode">OpenCode (CLI opencode run)</option>
            <option value="cloud">En la nube (compatible OpenAI)</option>
          </select>
        </label>
        {provider === "cloud" && (
          <>
            <p className="hint">
              Usa un servicio <strong>compatible con OpenAI</strong> en la nube (OpenAI, Groq,
              Gemini…) para proponer idioma, estilo y etiquetas a partir de los metadatos de cada
              canción. No se sube el audio: solo se envían título, artista, álbum, año, estilo,
              etiquetas y nombre del archivo. Las propuestas se revisan y se aceptan una a una
              antes de guardarlas.
            </p>
            <div className="field-row">
              <label className="field">
                <span className="field-label">Servicio</span>
                <select
                  value={serviceIdOf(ai.cloudUrl)}
                  onChange={(e) => {
                    const preset = CLOUD_SERVICES.find((x) => x.id === e.target.value);
                    if (preset?.url) {
                      setModels([]);
                      setAi({ cloudUrl: preset.url, cloudModel: preset.id === "ocgo" ? "glm-5.3-flash" : preset.id === "groq" ? "llama-3.3-70b-versatile" : "gpt-4o-mini" });
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
                <span className="field-label">Dirección del servicio (compatible OpenAI)</span>
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
                <input
                  type="text"
                  value={ai.cloudModel ?? ""}
                  spellCheck={false}
                  list="ai-models"
                  placeholder={CLOUD_SERVICES.find((x) => x.id === serviceIdOf(ai.cloudUrl))?.hint || "gpt-4o-mini"}
                  onChange={(e) => setAi({ cloudModel: e.target.value })}
                />
                <datalist id="ai-models">
                  {models.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
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
            <p className="hint">
              Usa un servidor <strong>Ollama</strong> en tu equipo para proponer idioma, estilo y
              etiquetas a partir de los metadatos de cada canción. No se sube el audio: solo se
              envían título, artista, álbum, año, estilo, etiquetas y nombre del archivo. Las
              propuestas se revisan y se aceptan una a una antes de guardarlas.
            </p>
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
                <input
                  type="text"
                  value={ai.model}
                  spellCheck={false}
                  list="ai-models"
                  placeholder="llama3.1:8b"
                  onChange={(e) => setAi({ model: e.target.value })}
                />
                <datalist id="ai-models">
                  {models.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
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
            <p className="hint">
              Usa <strong>OpenCode</strong> instalado en tu equipo: cada análisis lanza
              <code> opencode run</code> con una orden breve. No se sube el audio: solo se envían
              título, artista, álbum, año, estilo, etiquetas y nombre del archivo. Las propuestas
              se revisan y se aceptan una a una antes de guardarlas. Configura primero tu
              proveedor con <code>opencode auth login</code>.
            </p>
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
                <span className="field-label">Modelo (proveedor/modelo)</span>
                <input
                  type="text"
                  value={ai.model}
                  spellCheck={false}
                  list="ai-models"
                  placeholder="(el que tenga OpenCode por defecto)"
                  onChange={(e) => setAi({ model: e.target.value })}
                />
                <datalist id="ai-models">
                  {models.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
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

      {provider === "cloud" ? (
        <fieldset className="fieldset">
          <legend>Cómo preparar el servicio en la nube</legend>
          <p className="hint">
            Crea una API key en tu servicio y pégala arriba:
          </p>
          <pre className="ai-command">OpenCode Go · plataforma.opencode.ai/console · glm-5.3-flash
OpenAI · platform.openai.com/api-keys · gpt-4o-mini
Groq · console.groq.com/keys · llama-3.3-70b-versatile
Gemini · aistudio.google.com (la dirección la pone el preset)</pre>
          <p className="hint">
            La dirección acepta cualquier servicio que siga el formato de OpenAI. El modelo va
            tal como lo llama el servicio (se llena la lista al probar la conexión). Cada
            análisis manda solo los metadatos de la canción y tarda un par de segundos; los
            servicios gratuitos (Groq, Gemini) casi nunca se quedan cortos para catalogar.
          </p>
        </fieldset>
      ) : provider === "ollama" ? (
        <fieldset className="fieldset">
          <legend>Cómo preparar Ollama</legend>
          <p className="hint">
            Instala Ollama desde <strong>ollama.com</strong> y descarga un modelo, por ejemplo:
          </p>
          <pre className="ai-command">ollama pull llama3.1:8b</pre>
          <p className="hint">
            Si Ollama está en otro equipo o usa otro puerto, cambia la dirección. El análisis
            puede tardar unos segundos por canción según el modelo y el hardware.
          </p>
        </fieldset>
      ) : (
        <fieldset className="fieldset">
          <legend>Cómo preparar OpenCode</legend>
          <p className="hint">
            Instala OpenCode (<strong>curl -fsSL https://opencode.ai/install | bash</strong> o
            npm) y entra a tu proveedor una sola vez:
          </p>
          <pre className="ai-command">opencode auth login</pre>
          <p className="hint">
            El modelo se escribe como <strong>proveedor/modelo</strong> (con <code>opencode
            models</code> ves la lista: por ejemplo <code>openai/gpt-5.2</code>). Vacío usa el
            modelo por defecto de tu OpenCode. Cada análisis es un <code>opencode run</code>
            corto: el resultado llega con el JSON que la app espera; si el modelo se demora más
            de 4 minutos se cancela.
          </p>
        </fieldset>
      )}
    </>
  );
}
