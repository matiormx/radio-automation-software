import { useEffect, useMemo, useState } from "react";
import { cloudNode, type LiveState } from "../cloud";
import type { Track } from "../types";
import { closeOnBackdrop } from "../backdrop";

function fmt(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) secs = 0;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * El directo del estudio visto desde un puesto de trabajo: qué suena, la
 * playlist en antena y los mandos. Cada acción es una orden que ejecuta el
 * propio estudio (así nunca hay dos equipos reescribiendo la lista).
 */
export function StudioLive({
  tracks,
  onClose,
  showToast,
}: {
  tracks: Track[];
  onClose: () => void;
  showToast: (m: string) => void;
}) {
  const [live, setLive] = useState<LiveState | null>(cloudNode.live);
  const [now, setNow] = useState(Date.now());
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => cloudNode.subscribeLive(setLive), []);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, []);
  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    return tracks.filter((t) => !t.disabled && `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(s)).slice(0, 30);
  }, [q, tracks]);

  const send = async (cmd: Record<string, unknown>, ok?: string) => {
    setBusy(true);
    try {
      await cloudNode.remote(cmd);
      if (ok) showToast(ok);
    } catch (e) {
      showToast(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const pos = live ? Math.min(live.dur || Infinity, live.pos + (live.paused || live.row < 0 ? 0 : (now - live.at) / 1000)) : 0;
  const stale = live ? now - live.at > 45_000 : true;
  const playing = live?.row ?? -1;
  const nextRow = live ? (live.nextPick >= 0 ? live.nextPick : playing + 1) : -1;

  return (
    <div className="modal-backdrop" {...closeOnBackdrop(onClose)}>
      <div className="modal studio-live" role="dialog" aria-modal="true">
        <header className="studio-live-head">
          <h2>Directo del estudio</h2>
          <span className="hint">
            {!live
              ? "Esperando al estudio…"
              : stale
                ? "Sin noticias del estudio desde hace un rato"
                : `Playlist en antena: ${live.listName || "—"}`}
          </span>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Cerrar
          </button>
        </header>
        {live && (
          <>
            <div className="studio-live-now">
              <div className="t">
                <b>{playing >= 0 ? live.title || byId.get(live.ids[playing])?.title || "—" : "Nada sonando"}</b>
                {playing >= 0 && <span>{live.artist || byId.get(live.ids[playing])?.artist || ""}</span>}
              </div>
              <div className="studio-live-bar">
                <div style={{ width: live.dur > 0 ? `${Math.min(100, (pos / live.dur) * 100)}%` : "0%" }} />
              </div>
              <small className="hint">
                {fmt(pos)} / {fmt(live.dur)} {live.paused && playing >= 0 ? "· en pausa" : ""} {live.live ? "· LIVE" : ""}
              </small>
              <div className="studio-live-ctl">
                <button type="button" className="btn" disabled={busy} onClick={() => void send({ cmd: "prev" })} title="Anterior">
                  ⏮
                </button>
                <button type="button" className="btn btn-accent" disabled={busy} onClick={() => void send({ cmd: "toggle" })} title="Reproducir / pausa">
                  {live.paused || playing < 0 ? "▶" : "⏸"}
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => void send({ cmd: "next" })} title="Siguiente">
                  ⏭
                </button>
                <label className="check" style={{ marginLeft: 12 }}>
                  <input
                    type="checkbox"
                    checked={live.autopilot}
                    disabled={busy}
                    onChange={(e) => void send({ cmd: "autopilot", on: e.target.checked })}
                  />
                  Piloto automático
                </label>
              </div>
            </div>
            <div className="studio-live-add">
              <input type="search" placeholder="Buscar en la biblioteca para añadir al directo…" value={q} onChange={(e) => setQ(e.target.value)} />
              {hits.length > 0 && (
                <ul className="web-hits">
                  {hits.map((t) => (
                    <li key={t.id}>
                      <span>
                        <b>{t.title}</b> {t.artist && `· ${t.artist}`}
                      </span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => void send({ cmd: "liveInsert", id: t.id, at: Math.max(0, nextRow) }, `«${t.title}» sonará a continuación`)}
                      >
                        A continuación
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => void send({ cmd: "liveInsert", id: t.id, at: live.ids.length }, `«${t.title}» añadida al final`)}
                      >
                        Al final
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <ol className="web-rows studio-live-rows">
              {live.ids.map((id, i) => {
                const t = byId.get(id);
                const past = playing >= 0 && i < playing;
                return (
                  <li key={`${i}-${id}`} className={i === playing ? "on-air" : past ? "past" : ""}>
                    <span className="n">{i === playing ? "▶" : i + 1}</span>
                    <span className="t">
                      <b>{t?.title ?? "Canción que aún no ha llegado"}</b>
                      {t?.artist && <small> · {t.artist}</small>}
                      {i === nextRow && i !== playing && <small className="pill pill-auto" style={{ marginLeft: 6 }}>siguiente</small>}
                    </span>
                    {i !== playing && (
                      <>
                        <button type="button" className="btn btn-sm" disabled={busy} title="Que suene ya"
                          onClick={() => window.confirm(`¿Poner ya «${t?.title ?? "esta canción"}» en antena?`) && void send({ cmd: "playRow", i, expect: id })}>
                          ▶
                        </button>
                        <button type="button" className="btn btn-sm" disabled={busy} title="Que sea la siguiente" onClick={() => void send({ cmd: "setNext", i, expect: id })}>
                          ⤴
                        </button>
                        <button type="button" className="btn btn-sm" disabled={busy || i === 0} title="Subir" onClick={() => void send({ cmd: "move", from: i, to: i - 1, expect: id })}>
                          ↑
                        </button>
                        <button type="button" className="btn btn-sm" disabled={busy || i === live.ids.length - 1} title="Bajar" onClick={() => void send({ cmd: "move", from: i, to: i + 1, expect: id })}>
                          ↓
                        </button>
                        <button type="button" className="btn btn-sm" disabled={busy} title="Quitar del directo" onClick={() => void send({ cmd: "remove", i, expect: id })}>
                          ✕
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          </>
        )}
        <p className="hint">
          Las órdenes las ejecuta el estudio. Para poder darlas, este equipo necesita el permiso «Puede manejar el directo» en
          el panel del maestro.
        </p>
      </div>
    </div>
  );
}
