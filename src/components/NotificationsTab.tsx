import { useState } from "react";
import { notifyTest } from "../api";
import type { NotificationRule, Settings } from "../types";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  showToast: (msg: string) => void;
}

const EVENTS: { id: string; label: string }[] = [
  { id: "track", label: "Título de la pista en reproducción" },
  { id: "server", label: "Conexión o desconexión del servidor" },
  { id: "silence", label: "Detector de silencio" },
  { id: "error", label: "Errores" },
];

const VARS = "{text} {title} {artist} {album} {file} {event} {message}";

function newRule(): NotificationRule {
  return {
    id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: "Nueva notificación",
    enabled: true,
    url: "",
    method: "GET",
    body: "",
    bodyFormat: "form",
    events: ["track"],
    titleSource: "currentsong",
  };
}

/** Avisos HTTP (GET o POST) cuando ocurre algo en la emisión. */
export function NotificationsTab({ settings, onChange, showToast }: Props) {
  const list = settings.notifications ?? [];
  const [sel, setSel] = useState<string>(list[0]?.id ?? "");
  const cur = list.find((n) => n.id === sel) ?? list[0];
  const save = (next: NotificationRule[]) => onChange({ ...settings, notifications: next });
  const patch = (p: Partial<NotificationRule>) => cur && save(list.map((n) => (n.id === cur.id ? { ...n, ...p } : n)));

  return (
    <>
      <div className="camp-head">
        <div>
          <h4>Notificaciones</h4>
          <p className="hint">
            Envía una petición GET o POST a una dirección cuando ocurre algo: cambia la canción, se conecta o cae el
            servidor, se detecta silencio o hay un error. Sin reintentos. Variables en la URL y el cuerpo:{" "}
            <code>{VARS}</code>.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            const r = newRule();
            save([...list, r]);
            setSel(r.id);
          }}
        >
          + Añadir
        </button>
      </div>

      {list.length === 0 && <p className="hint">Aún no hay notificaciones.</p>}

      {list.length > 0 && (
        <div className="edit-blocks">
          {list.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`chip chip-toggle ${cur?.id === n.id ? "chip-on" : ""}`}
              onClick={() => setSel(n.id)}
              style={n.enabled ? undefined : { opacity: 0.55 }}
            >
              {n.name || "Sin nombre"}
            </button>
          ))}
        </div>
      )}

      {cur && (
        <fieldset className="fieldset">
          <legend>{cur.name || "Sin nombre"}</legend>
          <label className="check-field">
            <input type="checkbox" checked={cur.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
            Activada
          </label>
          <label className="field">
            <span className="field-label">Nombre</span>
            <input value={cur.name} onChange={(e) => patch({ name: e.target.value })} />
          </label>
          <label className="field">
            <span className="field-label">URL</span>
            <input
              value={cur.url}
              placeholder="https://servidor/api/metadata/update?key=…&song={text}"
              onChange={(e) => patch({ url: e.target.value })}
            />
          </label>
          <div className="field-row">
            <label className="field">
              <span className="field-label">Método</span>
              <select value={cur.method} onChange={(e) => patch({ method: e.target.value as "GET" | "POST" })}>
                <option value="GET">GET</option>
                <option value="POST">POST</option>
              </select>
            </label>
            {cur.method === "POST" && (
              <label className="field">
                <span className="field-label">Formato del cuerpo</span>
                <select
                  value={cur.bodyFormat}
                  onChange={(e) => patch({ bodyFormat: e.target.value as NotificationRule["bodyFormat"] })}
                >
                  <option value="form">Formulario (x-www-form-urlencoded)</option>
                  <option value="json">JSON</option>
                  <option value="text">Texto</option>
                </select>
              </label>
            )}
          </div>
          {cur.method === "POST" && (
            <label className="field">
              <span className="field-label">Cuerpo</span>
              <textarea
                rows={3}
                value={cur.body}
                placeholder={cur.bodyFormat === "json" ? '{"song":"{text}"}' : "song={text}"}
                onChange={(e) => patch({ body: e.target.value })}
              />
            </label>
          )}

          <div className="field">
            <span className="field-label">Avisar cuando…</span>
            {EVENTS.map((ev) => (
              <label key={ev.id} className="check-field">
                <input
                  type="checkbox"
                  checked={cur.events.includes(ev.id)}
                  onChange={(e) =>
                    patch({ events: e.target.checked ? [...cur.events, ev.id] : cur.events.filter((x) => x !== ev.id) })
                  }
                />
                {ev.label}
              </label>
            ))}
          </div>

          {cur.events.includes("track") && (
            <label className="field">
              <span className="field-label">Texto del cambio de canción ({"{text}"})</span>
              <select
                value={cur.titleSource}
                onChange={(e) => patch({ titleSource: e.target.value as "currentsong" | "live" })}
              >
                <option value="currentsong">CURRENTSONG: la canción que suena</option>
                <option value="live">LIVE: el texto de emisión (programa si el modo LIVE está activo)</option>
              </select>
            </label>
          )}

          <div className="field-row">
            <button
              type="button"
              className="btn btn-sm"
              disabled={!cur.url.trim()}
              onClick={() =>
                void notifyTest(cur)
                  .then((m) => showToast(m))
                  .catch((e) => showToast(`Falló la prueba: ${String(e)}`))
              }
            >
              Probar
            </button>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const next = list.filter((n) => n.id !== cur.id);
                save(next);
                setSel(next[0]?.id ?? "");
              }}
            >
              Eliminar
            </button>
          </div>
        </fieldset>
      )}
    </>
  );
}
