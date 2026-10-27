import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";

/**
 * Selector de archivos propio para el quiosco Linux: solo deja moverse por
 * las carpetas de trabajo (Música, Plugins, Descargas, Personal y memorias
 * USB), no por todo el sistema como el diálogo de GTK.
 */

export interface PickFilter {
  name: string;
  extensions: string[];
}
export interface PickOptions {
  title?: string;
  directory?: boolean;
  multiple?: boolean;
  filters?: PickFilter[];
  defaultPath?: string;
}

interface Place {
  label: string;
  path: string;
  kind: "drive" | "folder";
}
interface Entry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  modified: number;
}
interface Listing {
  path: string;
  parent: string | null;
  entries: Entry[];
}

type Mode = "open" | "save";
let lastDir = "";

/** Carpeta que contiene la ruta (separador «/» o «\»). */
function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
}
function baseOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}
function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : root + "/");
}
function fmtSize(n: number): string {
  if (n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
function fmtDate(s: number): string {
  if (!s) return "";
  const d = new Date(s * 1000);
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" }) +
    " " + d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

function Picker({ mode, opts, done }: { mode: Mode; opts: PickOptions; done: (v: string | string[] | null) => void }) {
  const [roots, setRoots] = useState<Place[]>([]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState(mode === "save" && opts.defaultPath ? baseOf(opts.defaultPath) : "");
  const [newFolder, setNewFolder] = useState<string | null>(null);

  const filters = opts.filters ?? [];
  const exts = useMemo(
    () => (opts.directory ? ["/"] : filters[filter]?.extensions ?? []),
    [opts.directory, filters, filter],
  );

  const go = (path: string) => {
    setError("");
    setSelected([]);
    invoke<Listing>("picker_list", { path, exts })
      .then((l) => {
        setListing(l);
        lastDir = l.path;
      })
      .catch((e) => setError(String(e)));
  };

  useEffect(() => {
    void invoke<{ roots: Place[] }>("picker_roots").then(({ roots }) => {
      setRoots(roots);
      const want = opts.defaultPath && opts.defaultPath.includes("/") ? (mode === "save" ? dirOf(opts.defaultPath) : opts.defaultPath) : lastDir;
      const start = want && roots.some((r) => inside(want, r.path)) ? want : roots[0]?.path;
      if (start) go(start);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cambiar el filtro vuelve a leer la carpeta actual
  useEffect(() => {
    if (listing) go(listing.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exts]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") done(null);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [done]);

  const root = roots
    .filter((r) => listing && inside(listing.path, r.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const crumbs: { label: string; path: string }[] = [];
  if (root && listing) {
    crumbs.push({ label: root.label, path: root.path });
    const rest = listing.path.slice(root.path.length).split("/").filter(Boolean);
    let acc = root.path;
    for (const part of rest) {
      acc = acc.endsWith("/") ? acc + part : `${acc}/${part}`;
      crumbs.push({ label: part, path: acc });
    }
  }

  const choose = (e: Entry) => {
    if (e.dir) {
      go(e.path);
      return;
    }
    if (mode === "save") {
      setName(e.name);
      return;
    }
    if (opts.directory) return;
    if (opts.multiple) {
      setSelected((s) => (s.includes(e.path) ? s.filter((x) => x !== e.path) : [...s, e.path]));
    } else {
      setSelected([e.path]);
    }
  };
  const open = (e: Entry) => {
    if (e.dir) go(e.path);
    else if (mode === "save") setName(e.name);
    else if (!opts.directory) done(opts.multiple ? [e.path] : e.path);
  };

  const saveName = () => {
    let n = name.trim();
    const ext = filters[filter]?.extensions[0];
    if (ext && !n.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) n += `.${ext}`;
    return n;
  };
  const exists = mode === "save" && listing?.entries.some((e) => !e.dir && e.name === saveName());

  const confirm = () => {
    if (!listing) return;
    if (mode === "save") {
      if (!name.trim() || /[\\/]/.test(name)) return;
      done(`${listing.path.replace(/\/$/, "")}/${saveName()}`);
    } else if (opts.directory) {
      done(opts.multiple ? [listing.path] : listing.path);
    } else if (selected.length) {
      done(opts.multiple ? selected : selected[0]);
    }
  };

  const mkdir = () => {
    if (!listing || !newFolder?.trim()) return;
    invoke<string>("picker_mkdir", { parent: listing.path, name: newFolder })
      .then((p) => {
        setNewFolder(null);
        go(p);
      })
      .catch((e) => setError(String(e)));
  };

  const canConfirm = mode === "save" ? !!name.trim() && !/[\\/]/.test(name) : opts.directory ? !!listing : selected.length > 0;
  const title = opts.title || (mode === "save" ? "Guardar como" : opts.directory ? "Elegir carpeta" : "Abrir");

  return (
    <div className="modal-backdrop fp-backdrop" onMouseDown={() => done(null)}>
      <div className="modal fp" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button type="button" className="ghost-btn" onClick={() => done(null)}>
            Cancelar
          </button>
        </div>
        <div className="fp-main">
          <nav className="fp-places">
            {roots.map((r) => (
              <button
                key={r.path}
                type="button"
                className={`fp-place${root?.path === r.path ? " active" : ""}`}
                onClick={() => go(r.path)}
                title={r.path}
              >
                <span className="fp-ico">{r.kind === "drive" ? "💾" : r.label === "Personal" ? "🔒" : "📁"}</span>
                {r.label}
              </button>
            ))}
            <p className="hint fp-note">Personal no se comparte por la red.</p>
          </nav>
          <section className="fp-files">
            <div className="fp-bar">
              <button type="button" className="btn btn-sm" disabled={!listing?.parent} onClick={() => listing?.parent && go(listing.parent)} title="Subir">
                ↑
              </button>
              <div className="fp-crumbs">
                {crumbs.map((c, i) => (
                  <button key={c.path} type="button" className="fp-crumb" onClick={() => go(c.path)}>
                    {i > 0 && <span className="fp-sep">›</span>}
                    {c.label}
                  </button>
                ))}
              </div>
              {(mode === "save" || opts.directory) &&
                (newFolder === null ? (
                  <button type="button" className="btn btn-sm" onClick={() => setNewFolder("")}>
                    Nueva carpeta
                  </button>
                ) : (
                  <span className="fp-newfolder">
                    <input autoFocus value={newFolder} placeholder="Nombre" onChange={(e) => setNewFolder(e.target.value)} onKeyDown={(e) => e.key === "Enter" && mkdir()} />
                    <button type="button" className="btn btn-sm btn-accent" onClick={mkdir}>
                      Crear
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => setNewFolder(null)}>
                      ✕
                    </button>
                  </span>
                ))}
            </div>
            <div className="fp-list">
              {error && <p className="hint update-error">{error}</p>}
              {listing && listing.entries.length === 0 && !error && (
                <p className="hint fp-empty">{opts.directory ? "Sin subcarpetas." : "No hay archivos compatibles en esta carpeta."}</p>
              )}
              {listing?.entries.map((e) => (
                <div
                  key={e.path}
                  className={`fp-row${selected.includes(e.path) ? " sel" : ""}`}
                  onClick={() => choose(e)}
                  onDoubleClick={() => open(e)}
                >
                  <span className="fp-ico">{e.dir ? "📁" : "📄"}</span>
                  <span className="fp-name">{e.name}</span>
                  <span className="fp-size">{e.dir ? "" : fmtSize(e.size)}</span>
                  <span className="fp-date">{fmtDate(e.modified)}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
        <div className="fp-foot">
          {mode === "save" && (
            <input className="fp-filename" value={name} placeholder="Nombre del archivo" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && confirm()} />
          )}
          {mode === "open" && !opts.directory && (
            <span className="hint fp-sel">{selected.length > 1 ? `${selected.length} archivos elegidos` : selected[0] ? baseOf(selected[0]) : opts.multiple ? "Haz clic en los archivos que quieras" : ""}</span>
          )}
          {opts.directory && <span className="hint fp-sel">{listing ? baseOf(listing.path) : ""}</span>}
          {exists && <span className="hint update-error">Se reemplazará el archivo que ya existe</span>}
          {filters.length > 1 && !opts.directory && (
            <select value={filter} onChange={(e) => setFilter(Number(e.target.value))}>
              {filters.map((f, i) => (
                <option key={f.name} value={i}>
                  {f.name}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="btn btn-accent" disabled={!canConfirm} onClick={confirm}>
            {mode === "save" ? "Guardar" : opts.directory ? "Elegir esta carpeta" : "Abrir"}
          </button>
        </div>
      </div>
    </div>
  );
}

function show(mode: Mode, opts: PickOptions): Promise<string | string[] | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const r = createRoot(host);
    const done = (v: string | string[] | null) => {
      r.unmount();
      host.remove();
      resolve(v);
    };
    r.render(<Picker mode={mode} opts={opts} done={done} />);
  });
}

export function pickOpen(opts: PickOptions): Promise<string | string[] | null> {
  return show("open", opts);
}

export async function pickSave(opts: PickOptions): Promise<string | null> {
  const v = await show("save", opts);
  return typeof v === "string" ? v : null;
}
