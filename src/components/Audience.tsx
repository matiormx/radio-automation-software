import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Oyentes ahora mismo (lo da el sondeo de Icecast de las emisiones). */
export interface ListenersNow {
  total: number;
  mounts: { name: string; listeners: number }[];
  updated: number;
  error: string;
  configured: boolean;
}
interface Point {
  t: number;
  avg: number;
  max: number;
}
export interface AudienceStats {
  days: number;
  samples: number;
  since: number;
  last24h: Point[];
  byHour: Point[];
  heat: number[][];
  peak: number;
  peakAt: number;
  avg: number;
  bestHours: number[];
}

const DAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
const clock = (t: number) => new Date(t * 1000).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
const dayTime = (t: number) =>
  new Date(t * 1000).toLocaleString("es-ES", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const n1 = (v: number) => (v >= 10 ? Math.round(v).toString() : v.toFixed(1).replace(".", ","));

/** Contador de oyentes de la barra principal (abre la audiencia). */
export function ListenersBadge({ onOpen }: { onOpen: () => void }) {
  const [now, setNow] = useState<ListenersNow | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void invoke<ListenersNow>("listeners_now")
        .then((v) => alive && setNow(v))
        .catch(() => undefined);
    load();
    const t = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);
  const stale = !now || !now.configured || (!!now.error && !now.updated);
  const title = !now?.configured
    ? "Oyentes: no hay emisiones Icecast configuradas"
    : now.error
      ? `Oyentes: ${now.error}${now.updated ? ` (último dato ${clock(now.updated)})` : ""}`
      : `Oyentes ahora: ${now.total}${now.mounts.length > 1 ? " · " + now.mounts.map((m) => `${m.name} ${m.listeners}`).join(" · ") : ""}. Clic para ver la audiencia por horas.`;
  return (
    <button type="button" className={`aud-badge${stale ? " stale" : ""}${now?.error ? " err" : ""}`} title={title} onClick={onOpen}>
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3 19c.6-3.3 3-5 6-5s5.4 1.7 6 5" />
        <circle cx="17" cy="9" r="2.4" />
        <path d="M16 14.2c2.4.2 4.3 1.7 4.8 4.3" />
      </svg>
      <b>{now?.configured && now.updated ? now.total : "–"}</b>
      <span>oyentes</span>
    </button>
  );
}

function BarChart({ points, labels, highlight, unit }: { points: Point[]; labels: (p: Point, i: number) => string; highlight?: number[]; unit: string }) {
  const W = 720;
  const H = 200;
  const pad = { l: 34, r: 8, t: 10, b: 22 };
  const top = Math.max(1, ...points.map((p) => Math.max(p.max, p.avg)));
  const step = top <= 5 ? 1 : top <= 20 ? 5 : top <= 100 ? 20 : Math.ceil(top / 5 / 50) * 50;
  const yMax = Math.ceil(top / step) * step;
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const bw = iw / points.length;
  const y = (v: number) => pad.t + ih - (v / yMax) * ih;
  const ticks: number[] = [];
  for (let v = 0; v <= yMax; v += step) ticks.push(v);
  const every = points.length > 48 ? 18 : points.length > 24 ? 6 : 2;
  return (
    <svg className="aud-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Gráfica de ${unit}`}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="aud-grid" />
          <text x={pad.l - 6} y={y(v) + 3} className="aud-axis" textAnchor="end">
            {v}
          </text>
        </g>
      ))}
      {points.map((p, i) => {
        const x = pad.l + i * bw;
        const has = p.avg >= 0;
        const hot = highlight?.includes(i);
        return (
          <g key={i}>
            {has && p.max > p.avg && <rect x={x + bw * 0.15} width={bw * 0.7} y={y(p.max)} height={Math.max(0, y(p.avg) - y(p.max))} className="aud-max" />}
            {has && <rect x={x + bw * 0.15} width={bw * 0.7} y={y(p.avg)} height={Math.max(0.5, pad.t + ih - y(p.avg))} className={hot ? "aud-bar hot" : "aud-bar"} />}
            <title>{`${labels(p, i)} · ${has ? `media ${n1(p.avg)}, máximo ${p.max}` : "sin datos"}`}</title>
            {i % every === 0 && (
              <text x={x + bw / 2} y={H - 6} className="aud-axis" textAnchor="middle">
                {labels(p, i)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Heat({ heat }: { heat: number[][] }) {
  const top = Math.max(1, ...heat.flat());
  return (
    <div className="aud-heat" role="table" aria-label="Audiencia media por día y hora">
      <span />
      {Array.from({ length: 24 }, (_, h) => (
        <span key={h} className="aud-heat-h">
          {h % 3 === 0 ? h : ""}
        </span>
      ))}
      {heat.map((row, d) => (
        <div className="aud-heat-row" key={d} role="row">
          <span className="aud-heat-d">{DAYS[d]}</span>
          {row.map((v, h) => (
            <span
              key={h}
              className="aud-heat-c"
              style={{ opacity: v < 0 ? 0.08 : 0.15 + 0.85 * (v / top) }}
              title={`${DAYS[d]} ${hh(h)}–${hh((h + 1) % 24)}: ${v < 0 ? "sin datos" : `${n1(v)} de media`}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Ventana de audiencia: últimas 24 h, por horas y mapa semanal. */
export function AudienceModal({ onClose }: { onClose: () => void }) {
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<AudienceStats | null>(null);
  const [now, setNow] = useState<ListenersNow | null>(null);
  const [view, setView] = useState<"24h" | "hours" | "week">("hours");
  useEffect(() => {
    void invoke<AudienceStats>("listeners_stats", { days }).then(setStats).catch(() => undefined);
  }, [days]);
  useEffect(() => {
    const load = () => void invoke<ListenersNow>("listeners_now").then(setNow).catch(() => undefined);
    load();
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const empty = !!stats && stats.samples === 0 && stats.last24h.every((p) => p.avg < 0);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal aud-modal" role="dialog" aria-modal="true" aria-label="Audiencia" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Audiencia</h3>
          <button type="button" className="ghost-btn" onClick={onClose}>
            Cerrar
          </button>
        </div>
        <div className="modal-body">
          <div className="aud-kpis">
            <div>
              <span>Ahora</span>
              <b>{now?.updated ? now.total : "–"}</b>
              {now?.mounts && now.mounts.length > 1 && <small>{now.mounts.map((m) => `${m.name} ${m.listeners}`).join(" · ")}</small>}
            </div>
            <div>
              <span>Media ({days} días)</span>
              <b>{stats ? n1(stats.avg) : "–"}</b>
            </div>
            <div>
              <span>Máximo</span>
              <b>{stats?.peak ?? "–"}</b>
              {stats && stats.peakAt > 0 && <small>{dayTime(stats.peakAt)}</small>}
            </div>
            <div>
              <span>Mejores franjas</span>
              <b className="aud-best">{stats?.bestHours.length ? stats.bestHours.map((h) => `${h}–${h + 1} h`).join(", ") : "–"}</b>
            </div>
          </div>
          {now?.error && <p className="hint update-error">No se pudieron leer los oyentes: {now.error}</p>}
          {!now?.configured && <p className="hint">No hay emisiones Icecast configuradas en Ajustes › Streaming.</p>}
          <div className="aud-tools">
            <div className="seg">
              <button type="button" className={`seg-btn${view === "24h" ? " seg-on" : ""}`} onClick={() => setView("24h")}>
                Últimas 24 h
              </button>
              <button type="button" className={`seg-btn${view === "hours" ? " seg-on" : ""}`} onClick={() => setView("hours")}>
                Por horas
              </button>
              <button type="button" className={`seg-btn${view === "week" ? " seg-on" : ""}`} onClick={() => setView("week")}>
                Semana
              </button>
            </div>
            {view !== "24h" && (
              <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Periodo">
                <option value={7}>Últimos 7 días</option>
                <option value={30}>Últimos 30 días</option>
                <option value={90}>Últimos 90 días</option>
                <option value={365}>Último año</option>
              </select>
            )}
          </div>
          {!stats ? (
            <p className="hint">Cargando…</p>
          ) : empty ? (
            <p className="hint">Aún no hay datos: OmniCaster apunta los oyentes cada minuto mientras está abierto. Vuelve en un rato.</p>
          ) : view === "24h" ? (
            <BarChart points={stats.last24h} labels={(p) => clock(p.t)} unit="oyentes en las últimas 24 horas" />
          ) : view === "hours" ? (
            <>
              <BarChart points={stats.byHour} labels={(p) => `${p.t}h`} highlight={stats.bestHours} unit="oyentes por hora del día" />
              <p className="hint">Barra: media de oyentes en esa hora · sombra: máximo · en color, las tres mejores franjas.</p>
            </>
          ) : (
            <>
              <Heat heat={stats.heat} />
              <p className="hint">Más intenso = más oyentes de media en esa hora de ese día de la semana.</p>
            </>
          )}
          {stats && stats.since > 0 && <p className="hint">Datos desde el {dayTime(stats.since)}.</p>}
        </div>
      </div>
    </div>
  );
}
