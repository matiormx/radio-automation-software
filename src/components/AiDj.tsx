import { useEffect, useRef, useState } from "react";
import { aiListenClear, aiListenStatus, aiPick, type AiChatMsg, type AiListenStatus, type AiPick } from "../api";
import { closeOnBackdrop } from "../backdrop";
import type { AiSettings } from "../types";

export interface AiDjContext {
  nowPlaying: string;
  upcoming: string[];
  recentIds: string[];
}

interface Msg extends AiChatMsg {
  picks?: AiPick[];
  heard?: string;
  error?: boolean;
}

interface Props {
  ai: AiSettings;
  /** Lo que suena, lo que viene y lo que ha sonado (se lee al preguntar) */
  context: () => AiDjContext;
  /** Pone la canción de siguiente o al final de la lista en antena */
  insert: (id: string, where: "next" | "end") => Promise<void> | void;
  canNext: boolean;
  /** Pregunta inicial (p. ej. al terminar el directo, según lo hablado) */
  autoAsk?: string;
  onClose: () => void;
  showToast: (m: string) => void;
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

// La conversación sigue ahí al cerrar y abrir la ventana (mientras la app esté abierta).
let kept: Msg[] = [];

/**
 * Asistente de canciones: el operador pide lo que quiere sonar y la IA
 * propone canciones de la biblioteca (que no hayan sonado hace poco).
 */
export function AiDj({ ai, context, insert, canNext, autoAsk, onClose, showToast }: Props) {
  const [msgs, setMsgs] = useState<Msg[]>(kept);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [listen, setListen] = useState<AiListenStatus | null>(null);
  const [useHeard, setUseHeard] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);
  const askedAuto = useRef(false);

  useEffect(() => {
    kept = msgs;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [msgs]);

  useEffect(() => {
    if (!ai.listenLive) return;
    let alive = true;
    const tick = () => void aiListenStatus().then((s) => alive && setListen(s)).catch(() => undefined);
    tick();
    const t = window.setInterval(tick, 10_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [ai.listenLive]);

  const ask = async (message: string) => {
    if (busy) return;
    const history: AiChatMsg[] = msgs.filter((m) => !m.error).map((m) => ({ role: m.role, text: m.text }));
    const shown = message.trim() || "¿Qué pongo ahora, según lo que se ha hablado?";
    setMsgs((m) => [...m, { role: "user", text: shown }]);
    setText("");
    setBusy(true);
    try {
      const c = context();
      const r = await aiPick(ai, {
        message,
        history,
        nowPlaying: c.nowPlaying,
        upcoming: c.upcoming,
        recentIds: c.recentIds,
        useTranscript: !!ai.listenLive && useHeard,
      });
      setMsgs((m) => [...m, { role: "assistant", text: r.reply || "Te propongo estas:", picks: r.picks, heard: r.heard }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", text: String(e), error: true }]);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (autoAsk !== undefined && !askedAuto.current) {
      askedAuto.current = true;
      void ask(autoAsk);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAsk]);

  const put = async (p: AiPick, where: "next" | "end") => {
    try {
      await insert(p.id, where);
      showToast(where === "next" ? `«${p.title}» suena a continuación` : `«${p.title}» añadida al final de la lista`);
    } catch (e) {
      showToast(String(e));
    }
  };

  const heardText = listen?.text ?? "";
  return (
    <div className="modal-backdrop" {...closeOnBackdrop(onClose)}>
      <div className="modal ai-dj" role="dialog" aria-modal="true">
        <header className="studio-live-head">
          <h2>Asistente de canciones</h2>
          <span className="hint">Propone canciones de tu biblioteca que no han sonado hace poco.</span>
          <span style={{ flex: 1 }} />
          {msgs.length > 0 && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setMsgs([])}>
              Nueva conversación
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Cerrar
          </button>
        </header>

        {ai.listenLive && (
          <div className="ai-dj-heard">
            <label className="check">
              <input type="checkbox" checked={useHeard} onChange={(e) => setUseHeard(e.target.checked)} />
              Tener en cuenta lo hablado en el directo
            </label>
            <span className="hint">
              {listen?.error
                ? `No se puede escuchar: ${listen.error}`
                : listen?.active
                  ? "Escuchando el directo…"
                  : heardText
                    ? "Directo terminado"
                    : "Se escucha cuando el directo está activo"}
            </span>
            {heardText && (
              <>
                <details>
                  <summary className="hint">Lo que se ha oído</summary>
                  <p className="hint ai-dj-transcript">{heardText}</p>
                </details>
                <button type="button" className="btn btn-sm" onClick={() => void aiListenClear().then(() => setListen((l) => (l ? { ...l, text: "" } : l)))}>
                  Olvidar
                </button>
              </>
            )}
          </div>
        )}

        <div className="ai-dj-chat">
          {msgs.length === 0 && (
            <div className="hint ai-dj-empty">
              Ejemplos: «algo alegre para empezar la mañana», «una balada en inglés de menos de 4
              minutos», «algo que hable de la gratitud», «parecido a lo que suena pero más
              movido».
              {ai.listenLive && " O pulsa «Según lo hablado» después de una intervención."}
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`ai-dj-msg ${m.role}${m.error ? " error" : ""}`}>
              <div className="ai-dj-text">{m.text}</div>
              {m.picks && m.picks.length > 0 && (
                <ul className="ai-dj-picks">
                  {m.picks.map((p) => (
                    <li key={p.id}>
                      <div className="ai-dj-pick-t">
                        <strong>{p.title}</strong> — {p.artist} <span className="hint">{fmt(p.durationSecs)}</span>
                        {p.reason && <div className="hint">{p.reason}</div>}
                      </div>
                      {canNext && (
                        <button type="button" className="btn btn-sm btn-accent" onClick={() => void put(p, "next")}>
                          Siguiente
                        </button>
                      )}
                      <button type="button" className="btn btn-sm" onClick={() => void put(p, "end")}>
                        Al final
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          {busy && <div className="ai-dj-msg assistant hint">Pensando… (puede tardar unos segundos)</div>}
          <div ref={endRef} />
        </div>

        <form
          className="ai-dj-input"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void ask(text);
          }}
        >
          <input
            className="input"
            autoFocus
            placeholder="¿Qué quieres que suene?"
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="btn btn-accent" disabled={busy || !text.trim()}>
            Pedir
          </button>
          {ai.listenLive && (
            <button type="button" className="btn" disabled={busy || !heardText} onClick={() => void ask("")} title="Propone canciones según lo último que se ha dicho en el directo">
              Según lo hablado
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
