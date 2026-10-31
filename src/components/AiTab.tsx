import { useCallback, useEffect, useState } from "react";
import { aiModels, aiOpencodeVersion } from "../api";
import { DEFAULT_SETTINGS, type Settings } from "../types";

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
  { id: "custom", label: "Otro (compatible OpenAI)", url: "", hint: "", model: "" },
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

      {provider === "cloud" ? (
        <fieldset className="fieldset">
          <legend>Cómo preparar el servicio en la nube</legend>
          <p className="hint">
            Crea una API key en tu servicio y pégala arriba:
          </p>
          <pre className="ai-command">OpenRouter · openrouter.ai/keys · los “:free” no gastan nada
Groq · console.groq.com/keys · Gemini · aistudio.google.com
Cerebras · cloud.cerebras.ai/keys · Mistral · console.mistral.ai
OpenCode (Zen/Go) · plataforma.opencode.ai · glm-5.3-flash
DeepSeek · platform.deepseek.com · OpenAI · platform.openai.com/api-keys</pre>
          <p className="hint">
            Ojo con la capa gratis del Zen de OpenCode: los modelos «-free» solo responden desde el
            propio OpenCode (otros clientes reciben 403). Desde OmniCaster salen tarificados por uso —
            con <code>glm-5.3-flash</code> cuesta centavos por miles de canciones.
          </p>
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
