import { useState } from "react";
import { aiModels } from "../api";
import { DEFAULT_SETTINGS, type Settings } from "../types";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  showToast: (msg: string) => void;
}

/**
 * Ajustes > IA: conexion con un Ollama local. El analisis solo envia los
 * metadatos de la ficha; el audio no sale del equipo.
 */
export function AiTab({ settings, onChange, showToast }: Props) {
  const ai = settings.ai ?? DEFAULT_SETTINGS.ai;
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const setAi = (patch: Partial<typeof ai>) => {
    onChange({ ...settings, ai: { ...ai, ...patch } });
  };

  const test = async () => {
    setBusy(true);
    setError("");
    try {
      const list = await aiModels(ai.url);
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

  return (
    <>
      <fieldset className="fieldset">
        <legend>Análisis de metadatos con IA local</legend>
        <p className="hint">
          Usa un servidor <strong>Ollama</strong> en tu equipo para proponer idioma, estilo y
          etiquetas a partir de los metadatos de cada canción. No se sube el audio: solo se envían
          título, artista, álbum, año, estilo, etiquetas y nombre del archivo. Las propuestas se
          revisan y se aceptan una a una antes de guardarlas.
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
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void test()}
            disabled={busy || !ai.url.trim()}
          >
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
      </fieldset>

      <fieldset className="fieldset">
        <legend>Cómo preparar Ollama</legend>
        <p className="hint">
          Instala Ollama desde <strong>ollama.com</strong> y descarga un modelo, por ejemplo:
        </p>
        <pre className="ai-command">ollama pull llama3.1:8b</pre>
        <p className="hint">
          Si Ollama está en otro equipo o usa otro puerto, cambia la dirección. El análisis puede
          tardar unos segundos por canción según el modelo y el hardware.
        </p>
      </fieldset>
    </>
  );
}
