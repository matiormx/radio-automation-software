import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface NetIf {
  name: string;
  rxBps: number;
  txBps: number;
}
interface Proc {
  name: string;
  cpu: number;
  mem: number;
  count: number;
}
interface Stats {
  cpu: number;
  memUsed: number;
  memTotal: number;
  rxBps: number;
  txBps: number;
  audioLoad: number;
  appCpu: number;
  appMem: number;
  cores: number[];
  nets: NetIf[];
  procs: Proc[];
  diskFree: number;
  diskTotal: number;
}

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(b >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
const mb = (b: number) => (b >= 1024 ** 3 ? gb(b) : `${Math.round(b / 1024 ** 2)} MB`);
const bps = (v: number) =>
  v >= 1e9 ? `${(v / 1e9).toFixed(1)} Gb/s` : v >= 1e6 ? `${(v / 1e6).toFixed(1)} Mb/s` : `${Math.round(v / 1e3)} kb/s`;
const tone = (pct: number) => (pct >= 85 ? "sm-bad" : pct >= 65 ? "sm-warn" : "sm-ok");

/**
 * Monitor del sistema en la barra superior: CPU, memoria, red y motor de
 * audio en una línea; al pulsar, el detalle (núcleos, procesos, red, disco).
 * Consulta cada 3 s (cada 2 s con el detalle abierto) y nada si la ventana
 * está oculta.
 */
export function SysMonitor() {
  const [s, setS] = useState<Stats | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (document.hidden) return;
      void invoke<Stats>("sys_stats", { detail: open })
        .then((v) => alive && setS(v))
        .catch(() => undefined);
    };
    tick();
    const t = window.setInterval(tick, open ? 2000 : 3000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!s) return null;
  const ram = s.memTotal > 0 ? (s.memUsed / s.memTotal) * 100 : 0;
  const worst = Math.max(s.cpu, ram, s.audioLoad);
  return (
    <div className="sm" ref={box}>
      <button
        type="button"
        className={`sm-pill sm-p-${tone(worst).slice(3)}`}
        title="Carga del equipo (pulsa para ver el detalle)"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="sm-dot" />
        <span>CPU {Math.round(s.cpu)}%</span>
        <span>RAM {Math.round(ram)}%</span>
        <span className="sm-net">↓{bps(s.rxBps)} ↑{bps(s.txBps)}</span>
      </button>
      {open && (
        <div className="sm-pop" role="dialog" aria-label="Monitor del sistema">
          <div className="sm-row">
            <span>Procesador</span>
            <Bar pct={s.cpu} />
            <b>{Math.round(s.cpu)}%</b>
          </div>
          {s.cores.length > 0 && (
            <div className="sm-cores" title="Cada núcleo">
              {s.cores.map((c, i) => (
                <i key={i} className={tone(c)} style={{ height: `${Math.max(4, c)}%` }} />
              ))}
            </div>
          )}
          <div className="sm-row">
            <span>Memoria</span>
            <Bar pct={ram} />
            <b>
              {gb(s.memUsed)} / {gb(s.memTotal)}
            </b>
          </div>
          <div className="sm-row" title="Tiempo que tarda el motor en mezclar cada bloque de audio. Cerca del 100 % se oirían cortes.">
            <span>Motor de audio</span>
            <Bar pct={s.audioLoad} />
            <b>{s.audioLoad.toFixed(1)}%</b>
          </div>
          <div className="sm-head">Red</div>
          {s.nets.length === 0 && <div className="sm-dim">Sin tráfico</div>}
          {s.nets.slice(0, 4).map((n) => (
            <div className="sm-line" key={n.name}>
              <span title={n.name}>{n.name}</span>
              <b>
                ↓{bps(n.rxBps)} ↑{bps(n.txBps)}
              </b>
            </div>
          ))}
          <div className="sm-head">OmniCaster</div>
          {s.procs.map((p) => (
            <div className="sm-line" key={p.name}>
              <span>
                {p.name}
                {p.count > 1 ? ` (${p.count})` : ""}
              </span>
              <b>
                {p.cpu.toFixed(1)}% · {mb(p.mem)}
              </b>
            </div>
          ))}
          <div className="sm-line sm-total">
            <span>Total</span>
            <b>
              {s.appCpu.toFixed(1)}% · {mb(s.appMem)}
            </b>
          </div>
          {s.diskTotal > 0 && (
            <div className="sm-line">
              <span>Disco de datos libre</span>
              <b>
                {gb(s.diskFree)} de {gb(s.diskTotal)}
              </b>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Bar({ pct }: { pct: number }) {
  return (
    <span className="sm-bar">
      <i className={tone(pct)} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </span>
  );
}
