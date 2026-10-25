import { DeezerSearch } from "./DeezerSearch";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { languageFlag, languageName } from "../languages";
import type { AiSettings, Block, HistoryEntry, PlaylistImportReport, Track, TrackPatch } from "../types";
import {
  updateTrack,
  setTrackCover,
  clearTrackCover,
  pickCoverImage,
  trackUrl,
  relinkTrack,
  setTrackBlocks,
  pickSingleAudioFile,
  pickPlaylistFile,
  importPlaylist,
  isVideoFile,
} from "../api";
import { TrackDetailsModal } from "./TrackDetailsModal";
import { pickScanFolder, scanFolder } from "../api";
import { listen } from "@tauri-apps/api/event";

const LOSSLESS = new Set(["flac", "wav", "aif", "aiff", "alac", "ape", "wv"]);
const LOSSY = new Set(["mp3", "wma", "mp2", "aac", "m4a", "ogg", "opus"]);

/** Etiqueta de calidad: FLAC / Hi-Res, o aviso de MP3 de baja calidad. */
export function qualityBadge(t: Track): ReactNode {
  let fmt = (t.format ?? "").toLowerCase();
  // M4A por encima de 320 kbps (o con profundidad de bits) es ALAC: sin pérdida, como FLAC.
  if ((fmt === "m4a" || fmt === "mp4") && ((t.audioKbps ?? 0) > 320 || (t.audioBits ?? 0) > 0)) fmt = "alac";
  const rate = t.audioRate ?? 0;
  const bits = t.audioBits ?? 0;
  const detail = [rate ? `${(rate / 1000).toFixed(rate % 1000 ? 1 : 0)} kHz` : "", bits ? `${bits} bits` : "", t.audioKbps ? `${t.audioKbps} kbps` : ""]
    .filter(Boolean)
    .join(" · ");
  if (LOSSLESS.has(fmt)) {
    const hires = rate > 48000 || bits > 16;
    return (
      <span className={`badge-q ${hires ? "badge-q-hires" : "badge-q-lossless"}`} title={`Sin pérdida${detail ? ` · ${detail}` : ""}`}>
        {fmt.toUpperCase()}
        {hires ? " Hi-Res" : ""}
      </span>
    );
  }
  if (LOSSY.has(fmt)) {
    // Con pérdida: ≤128 kbps mala calidad; 256-320 aceptable; nunca al nivel de FLAC.
    const k = t.audioKbps ?? 0;
    const tier = k === 0 ? "unk" : k <= 128 ? "low" : k < 256 ? "mid" : "ok";
    const text = tier === "low" ? "mala calidad" : tier === "mid" ? "calidad justa" : tier === "ok" ? "aceptable" : "con pérdida";
    const tip =
      tier === "ok"
        ? "Con pérdida: aceptable, pero por debajo de FLAC o Hi-Res"
        : tier === "low"
          ? "Con pérdida y bitrate bajo: mala calidad para emitir"
          : "Con pérdida: mejor sustituir por FLAC si es posible";
    return (
      <span className={`badge-q badge-q-${tier === "low" ? "low" : tier === "ok" ? "ok" : "mid"}`} title={`${tip}${detail ? ` · ${detail}` : ""}`}>
        {fmt.toUpperCase()}
        {k ? ` ${k}` : ""} · {text}
      </span>
    );
  }
  return null;
}
import { AiMetadataModal } from "./AiMetadataModal";
import {
  IconPlus,
  IconSearch,
  IconTrash,
  IconImport,
  IconScan,
  IconEdit,
  IconLink,
  IconBolt,
  IconList,
  IconFolder,
  IconChevron,
  IconMore,
  IconTag,
  IconWave,
  IconSparkles,
} from "../icons";

type Mode = "folders" | "artists" | "blocks" | "genres" | "tags" | "history";
type SortKey = "title" | "album" | "genre" | "duration";
const NONE = "__none";

interface MusicBrowserProps {
  tracks: Track[];
  blocks: Block[];
  history: HistoryEntry[];
  autoBlocks: string[];
  languages: string[];
  ai: AiSettings;
  onToggleAutoBlock: (blockId: string) => void;
  onCreateBlock: (name: string) => Promise<void>;
  onRenameBlock: (id: string, name: string) => Promise<void>;
  onDeleteBlock: (id: string) => Promise<void>;
  onScan: () => Promise<number>;
  onPickFiles: () => void;
  onAdd: (track: Track) => void;
  onDelete: (track: Track) => void;
  onTrackSaved: () => Promise<void>;
  onEditCuts: (track: Track) => void;
  /** Peticion de edicion de metadatos desde otra zona de la app */
  pendingEdit: { id: string; n: number } | null;
  onPendingEditDone: () => void;
  /** Bloque sobre el que se estan soltando archivos */
  dropBlockId?: string;
  showToast: (msg: string) => void;
}

interface EditState {
  id: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  year: string;
  tagsText: string;
  language: string;
  blocks: string[];
  busy: boolean;
  /** Caratula actual (ruta) */
  cover: string;
  /** Cambio pendiente: imagen local, URL (Deezer) o quitarla */
  coverChange: { kind: "file" | "url"; source: string } | { kind: "clear" } | null;
}

interface ImportState {
  path: string;
  fileName: string;
  mode: "existing" | "new";
  blockId: string;
  newName: string;
  copy: boolean;
  busy: boolean;
  report: PlaylistImportReport | null;
}

interface CtxMenu {
  track: Track;
  x: number;
  y: number;
}

interface FolderNode {
  name: string;
  path: string;
  count: number;
  children: FolderNode[];
}

type BlockLayoutItem =
  | { kind: "block"; id: string }
  | { kind: "separator"; id: string; title: string };

const BLOCK_LAYOUT_KEY = "miradio.blocks.layout";
const SIDE_WIDTH_KEY = "miradio.music.sideWidth";

function loadBlockLayout(): BlockLayoutItem[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(BLOCK_LAYOUT_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is BlockLayoutItem => {
      if (!item || typeof item !== "object") return false;
      const entry = item as Partial<BlockLayoutItem>;
      if (entry.kind === "block") return typeof entry.id === "string";
      return (
        entry.kind === "separator" &&
        typeof entry.id === "string" &&
        typeof entry.title === "string"
      );
    });
  } catch {
    return [];
  }
}

function layoutItemKey(item: BlockLayoutItem): string {
  return `${item.kind}:${item.id}`;
}

function loadSideWidth(): number {
  const value = Number(localStorage.getItem(SIDE_WIDTH_KEY));
  return Number.isFinite(value) && value >= 120 ? Math.min(480, value) : 186;
}

const MODES: { id: Mode; label: string }[] = [
  { id: "folders", label: "Carpetas" },
  { id: "artists", label: "Artistas" },
  { id: "blocks", label: "Bloques" },
  { id: "genres", label: "Estilos" },
  { id: "tags", label: "Etiquetas" },
  { id: "history", label: "Historial" },
];

/** Cuantas canciones ya emitidas se ven a la vez. */
const HISTORY_LIMIT = 25;

function fmtTime(secs: number): string {
  if (!secs || secs <= 0) return "--:--";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function fileStem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

const normPath = (p: string): string =>
  p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

function buildFolderTree(tracks: Track[]): FolderNode[] {
  const roots: FolderNode[] = [];
  const findNode = (list: FolderNode[], name: string, path: string): FolderNode => {
    let n = list.find((x) => x.name === name);
    if (!n) {
      n = { name, path, count: 0, children: [] };
      list.push(n);
    }
    return n;
  };

  for (const t of tracks) {
    if (!t.file) continue;
    const slash = Math.max(t.file.lastIndexOf("\\"), t.file.lastIndexOf("/"));
    if (slash <= 0) continue;
    const dir = t.file.slice(0, slash);
    const isAbs = /^\//.test(dir) || /^[A-Za-z]:/.test(dir);
    const sep = dir.includes("\\") ? "\\" : "/";
    const parts = dir.split(/[\\/]+/).filter(Boolean);

    let list = roots;
    let acc = "";
    for (const part of parts) {
      if (acc === "") {
        acc = isAbs && !/^[A-Za-z]:/.test(part) ? sep + part : part;
      } else {
        acc = acc + sep + part;
      }
      const node = findNode(list, part, acc);
      node.count += 1;
      list = node.children;
    }
  }

  const sortTree = (nodes: FolderNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, "es"));
    for (const n of nodes) sortTree(n.children);
  };
  sortTree(roots);
  return roots;
}

function FolderTree({
  nodes,
  depth,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  nodes: FolderNode[];
  depth: number;
  expanded: Set<string>;
  selected: string;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((n) => {
        const hasChildren = n.children.length > 0;
        const open = expanded.has(n.path);
        return (
          <div key={n.path}>
            <div
              className={`nav-item ${selected === n.path ? "nav-item-on" : ""}`}
              style={{ paddingLeft: 6 + depth * 13 }}
              onClick={() => onSelect(n.path)}
              title={n.path}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSelect(n.path);
              }}
            >
              {hasChildren ? (
                <button
                  type="button"
                  className={`nav-caret ${open ? "nav-caret-open" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(n.path);
                  }}
                  aria-label={open ? "Contraer carpeta" : "Expandir carpeta"}
                >
                  <IconChevron size={9} />
                </button>
              ) : (
                <span className="nav-caret" />
              )}
              <IconFolder size={12} />
              <span className="nav-name">{n.name}</span>
              <span className="nav-count">{n.count}</span>
            </div>
            {hasChildren && open && (
              <FolderTree
                nodes={n.children}
                depth={depth + 1}
                expanded={expanded}
                selected={selected}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export function MusicBrowser({
  tracks,
  blocks,
  history,
  autoBlocks,
  languages,
  ai,
  onToggleAutoBlock,
  onCreateBlock,
  onRenameBlock,
  onDeleteBlock,
  onScan,
  onPickFiles,
  onAdd,
  onDelete,
  onTrackSaved,
  onEditCuts,
  pendingEdit,
  onPendingEditDone,
  dropBlockId = "",
  showToast,
}: MusicBrowserProps) {
  const [mode, setMode] = useState<Mode>("folders");
  const [selection, setSelection] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "title", dir: 1 });
  const [selectedId, setSelectedId] = useState("");
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [propsId, setPropsId] = useState("");
  const [imp, setImp] = useState<ImportState | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [newBlock, setNewBlock] = useState("");
  const [renamingId, setRenamingId] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [scanning, setScanning] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sideWidth, setSideWidth] = useState(loadSideWidth);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [blockLayout, setBlockLayout] = useState<BlockLayoutItem[]>(loadBlockLayout);
  const [newSeparator, setNewSeparator] = useState("");
  const [renamingSeparator, setRenamingSeparator] = useState("");
  const [separatorValue, setSeparatorValue] = useState("");
  const [draggingBlock, setDraggingBlock] = useState("");
  const [dragOverBlock, setDragOverBlock] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);

  const blockNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of blocks) m.set(b.id, b.name);
    return m;
  }, [blocks]);

  useEffect(() => {
    try {
      localStorage.setItem(BLOCK_LAYOUT_KEY, JSON.stringify(blockLayout));
    } catch {
      /* sin almacenamiento */
    }
  }, [blockLayout]);

  // Mantiene el orden guardado y descarta bloques que ya no existen.
  useEffect(() => {
    setBlockLayout((prev) => {
      const valid = new Set(blocks.map((block) => block.id));
      const seen = new Set<string>();
      const next: BlockLayoutItem[] = [];
      for (const item of prev) {
        if (item.kind === "separator") {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          next.push(item);
        } else if (valid.has(item.id) && !seen.has(`block:${item.id}`)) {
          seen.add(`block:${item.id}`);
          next.push(item);
        }
      }
      for (const block of blocks) {
        if (!seen.has(`block:${block.id}`)) next.push({ kind: "block", id: block.id });
      }
      if (JSON.stringify(next) === JSON.stringify(prev)) return prev;
      return next;
    });
  }, [blocks]);

  const blockItems = useMemo(() => {
    const valid = new Set(blocks.map((block) => block.id));
    const seen = new Set<string>();
    const items: BlockLayoutItem[] = [];
    for (const item of blockLayout) {
      if (item.kind === "separator") {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
      } else if (valid.has(item.id) && !seen.has(`block:${item.id}`)) {
        seen.add(`block:${item.id}`);
        items.push(item);
      }
    }
    for (const block of blocks) {
      if (!seen.has(`block:${block.id}`)) items.push({ kind: "block", id: block.id });
    }
    return items;
  }, [blockLayout, blocks]);

  const addSeparator = () => {
    const title = newSeparator.trim();
    if (!title) return;
    setBlockLayout([
      ...blockItems,
      { kind: "separator", id: `sep${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, title },
    ]);
    setNewSeparator("");
  };

  const commitSeparatorRename = () => {
    const id = renamingSeparator;
    const title = separatorValue.trim();
    setRenamingSeparator("");
    if (!id || !title) return;
    setBlockLayout((prev) =>
      prev.map((item) => (item.kind === "separator" && item.id === id ? { ...item, title } : item)),
    );
  };

  const removeSeparator = (id: string) => {
    setBlockLayout(blockItems.filter((item) => !(item.kind === "separator" && item.id === id)));
  };

  const moveBlockItem = (fromKey: string, toKey: string) => {
    if (!fromKey || !toKey || fromKey === toKey) return;
    const from = blockItems.findIndex((item) => layoutItemKey(item) === fromKey);
    const to = blockItems.findIndex((item) => layoutItemKey(item) === toKey);
    if (from < 0 || to < 0) return;
    const next = [...blockItems];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setBlockLayout(next);
  };

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    resizeRef.current = { startX: e.clientX, startWidth: sideWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const resizeTo = (startX: number, startWidth: number, clientX: number) =>
    Math.max(120, Math.min(480, startWidth + clientX - startX));
  const moveResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = resizeRef.current;
    if (!state) return;
    setSideWidth(resizeTo(state.startX, state.startWidth, e.clientX));
  };
  const finishResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = resizeRef.current;
    if (!state) return;
    const width = resizeTo(state.startX, state.startWidth, e.clientX);
    resizeRef.current = null;
    setSideWidth(width);
    try {
      localStorage.setItem(SIDE_WIDTH_KEY, String(width));
    } catch {
      /* sin almacenamiento */
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const folderTree = useMemo(() => buildFolderTree(tracks), [tracks]);

  // Al cambiar de biblioteca, deja los discos/carpetas raíz abiertos.
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const n of folderTree) next.add(n.path);
      return next;
    });
  }, [folderTree]);

  const artists = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tracks) {
      const a = t.artist.trim() || "Artista desconocido";
      m.set(a, (m.get(a) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], "es"));
  }, [tracks]);

  const genres = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tracks) {
      const g = t.genre.trim() || "Sin estilo";
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], "es"));
  }, [tracks]);

  const tags = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tracks) {
      for (const tag of t.tags) m.set(tag, (m.get(tag) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], "es"));
  }, [tracks]);

  const blockCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tracks) {
      for (const b of t.blocks) m.set(b, (m.get(b) ?? 0) + 1);
    }
    return m;
  }, [tracks]);

  const noBlockCount = useMemo(() => tracks.filter((t) => t.blocks.length === 0).length, [tracks]);

  const noTagCount = useMemo(() => tracks.filter((t) => t.tags.length === 0).length, [tracks]);

  // Canciones ya emitidas, de la mas reciente a la mas antigua.
  const playedTracks = useMemo(() => {
    if (history.length === 0) return [];
    const byId = new Map(tracks.map((t) => [t.id, t]));
    const seen = new Set<string>();
    const out: { track: Track; playedAt: number }[] = [];
    for (const entry of history) {
      if (seen.has(entry.trackId)) continue;
      seen.add(entry.trackId);
      const track = byId.get(entry.trackId);
      if (!track) continue;
      out.push({ track, playedAt: entry.playedAt });
      if (out.length >= HISTORY_LIMIT) break;
    }
    return out;
  }, [history, tracks]);

  const filtered = useMemo(() => {
    let list = tracks;
    if (selection) {
      if (mode === "folders") {
        const dir = normPath(selection);
        list = list.filter((t) => {
          const f = normPath(t.file);
          return f === dir || f.startsWith(dir + "/");
        });
      } else if (mode === "artists") {
        list = list.filter((t) => (t.artist.trim() || "Artista desconocido") === selection);
      } else if (mode === "blocks") {
        list =
          selection === NONE
            ? list.filter((t) => t.blocks.length === 0)
            : list.filter((t) => t.blocks.includes(selection));
      } else if (mode === "genres") {
        list =
          selection === NONE
            ? list.filter((t) => !t.genre.trim())
            : list.filter((t) => t.genre === selection);
      } else if (mode === "tags") {
        list =
          selection === NONE
            ? list.filter((t) => t.tags.length === 0)
            : list.filter((t) => t.tags.includes(selection));
      }
    }

    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q) ||
          t.album.toLowerCase().includes(q) ||
          t.genre.toLowerCase().includes(q) ||
          t.year.includes(q) ||
          t.tags.some((tag) => tag.toLowerCase().includes(q)) ||
          t.originalName.toLowerCase().includes(q),
      );
    }

    const dir = sort.dir;
    return [...list].sort((a, b) => {
      let d = 0;
      if (sort.key === "duration") d = a.durationSecs - b.durationSecs;
      else if (sort.key === "album") d = a.album.localeCompare(b.album, "es");
      else if (sort.key === "genre") d = a.genre.localeCompare(b.genre, "es");
      else d = a.title.localeCompare(b.title, "es");
      if (d === 0) d = a.artist.localeCompare(b.artist, "es");
      return d * dir;
    });
  }, [tracks, mode, selection, query, sort]);

  const changeMode = (m: Mode) => {
    setMode(m);
    setSelection("");
    setCtx(null);
  };

  const toggleSort = (key: SortKey) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  };

  const toggleFolder = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const closeCtx = useCallback(() => setCtx(null), []);

  useEffect(() => {
    if (!ctx) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtx(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", closeCtx);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", closeCtx);
    };
  }, [ctx, closeCtx]);

  const openCtx = (track: Track, x: number, y: number) => {
    const w = 216;
    const h = 214;
    setCtx({
      track,
      x: Math.max(6, Math.min(x, window.innerWidth - w - 6)),
      y: Math.max(6, Math.min(y, window.innerHeight - h - 6)),
    });
    setSelectedId(track.id);
  };

  // Edicion de metadatos solicitada desde la lista de emision.
  useEffect(() => {
    if (!pendingEdit) return;
    const t = tracks.find((x) => x.id === pendingEdit.id);
    if (t) {
      setEdit({
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        genre: t.genre,
        year: t.year,
        tagsText: t.tags.join(", "),
      language: t.language ?? "",
        blocks: [...t.blocks],
        busy: false,
        cover: t.cover,
        coverChange: null,
      });
    }
    onPendingEditDone();
  }, [pendingEdit, tracks, onPendingEditDone]);

  const openEditor = (t: Track) => {
    setEdit({
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: t.album,
      genre: t.genre,
      year: t.year,
      tagsText: t.tags.join(", "),
      language: t.language ?? "",
      blocks: [...t.blocks],
      busy: false,
      cover: t.cover,
      coverChange: null,
    });
  };

  const saveEdit = async () => {
    if (!edit) return;
    setEdit({ ...edit, busy: true });
    try {
      const patch: TrackPatch = {
        title: edit.title.trim() || "Sin título",
        artist: edit.artist.trim(),
        album: edit.album.trim(),
        genre: edit.genre.trim(),
        year: edit.year.trim(),
        language: edit.language,
        tags: edit.tagsText
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
      await updateTrack(edit.id, patch);
      await setTrackBlocks(edit.id, edit.blocks);
      // La caratula va despues: si cambio el album, se guarda en el nuevo.
      const cc = edit.coverChange;
      if (cc?.kind === "clear") await clearTrackCover(edit.id);
      else if (cc) await setTrackCover(edit.id, cc.source);
      await onTrackSaved();
      setEdit(null);
      showToast("Canción actualizada");
    } catch (e) {
      showToast(`No se pudo guardar: ${String(e)}`);
      setEdit((s) => (s ? { ...s, busy: false } : s));
    }
  };

  const doRelink = async (id: string) => {
    const path = await pickSingleAudioFile();
    if (!path) return;
    try {
      await relinkTrack(id, path);
      await onTrackSaved();
      setEdit(null);
      showToast("Canción relinkada a un nuevo archivo");
    } catch (e) {
      showToast(`No se pudo relinkar: ${String(e)}`);
    }
  };

  const openProperties = (t: Track) => {
    setPropsId(t.id);
  };

  const [deezerOpen, setDeezerOpen] = useState(false);

  const [scanInfo, setScanInfo] = useState("");
  const doScanFolder = async () => {
    const dir = await pickScanFolder().catch(() => null);
    if (!dir) return;
    setScanning(true);
    setScanInfo("Buscando archivos…");
    const off = listen<{ phase: string; done: number; total: number }>("library://scan", (e) => {
      const p = e.payload;
      setScanInfo(p.phase === "list" ? "Buscando archivos…" : `Leyendo ${p.done} de ${p.total}…`);
    });
    try {
      const n = await scanFolder(dir);
      if (n > 0) await onTrackSaved();
      showToast(
        n === 0
          ? "No había canciones nuevas en esa carpeta"
          : n === 1
            ? "1 canción añadida al catálogo"
            : `${n} canciones añadidas al catálogo`,
      );
    } catch (e) {
      showToast(`No se pudo escanear: ${String(e)}`);
    } finally {
      void off.then((fn) => fn());
      setScanInfo("");
      setScanning(false);
    }
  };

  const doScan = async () => {
    setScanning(true);
    try {
      const n = await onScan();
      if (n === 0) {
        showToast("La carpeta de música ya está completamente catalogada");
      } else {
        await onTrackSaved();
        showToast(
          n === 1
            ? "1 canción catalogada en la carpeta de música"
            : `${n} canciones catalogadas en la carpeta de música`,
        );
      }
    } catch (e) {
      showToast(`No se pudo escanear: ${String(e)}`);
    } finally {
      setScanning(false);
    }
  };

  const openPlaylistImport = async () => {
    try {
      const path = await pickPlaylistFile();
      if (!path) return;
      const fileName = baseName(path);
      const preferred = mode === "blocks" && selection && selection !== NONE ? selection : "";
      const existing = blocks.some((b) => b.id === preferred) ? preferred : blocks[0]?.id ?? "";
      setImp({
        path,
        fileName,
        mode: existing ? "existing" : "new",
        blockId: existing,
        newName: fileStem(fileName),
        copy: false,
        busy: false,
        report: null,
      });
    } catch (e) {
      showToast(`No se pudo abrir la lista: ${String(e)}`);
    }
  };

  const submitImport = async () => {
    if (!imp || imp.busy) return;
    setImp({ ...imp, busy: true });
    try {
      const res = await importPlaylist(
        imp.path,
        imp.mode === "existing" ? imp.blockId || null : null,
        imp.mode === "new" ? imp.newName.trim() || null : null,
        imp.copy,
      );
      await onTrackSaved();
      setMode("blocks");
      setSelection(res.blockId);
      setImp((s) => (s ? { ...s, busy: false, report: res } : s));
      showToast(`«${res.blockName}»: ${res.added + res.matched} canciones en el bloque`);
    } catch (e) {
      showToast(`No se pudo importar la lista: ${String(e)}`);
      setImp((s) => (s ? { ...s, busy: false } : s));
    }
  };

  const tryCreateBlock = async () => {
    const name = newBlock.trim();
    if (!name) return;
    try {
      await onCreateBlock(name);
      setNewBlock("");
    } catch (e) {
      showToast(String(e));
    }
  };

  const submitRename = async () => {
    const id = renamingId;
    const name = renameValue.trim();
    setRenamingId("");
    if (!id || !name) return;
    try {
      await onRenameBlock(id, name);
    } catch (e) {
      showToast(String(e));
    }
  };

  const tryDeleteBlock = async (b: Block) => {
    try {
      await onDeleteBlock(b.id);
      if (selection === b.id) setSelection("");
    } catch (e) {
      showToast(String(e));
    }
  };

  const selectionLabel = (() => {
    if (!selection) return "Toda la música";
    if (mode === "folders") return baseName(selection.replace(/[\\/]+$/, "")) || selection;
    if (mode === "blocks") return selection === NONE ? "Sin bloque" : blockNames.get(selection) ?? "Bloque";
    if (mode === "genres") return selection === NONE ? "Sin estilo" : selection;
    if (mode === "tags") return selection === NONE ? "Sin etiquetas" : selection;
    if (mode === "history") return "Últimas canciones emitidas";
    return selection;
  })();


  // Fila de cancion (biblioteca o historial): misma interaccion en ambas listas.
  const rowFor = (t: Track, last?: ReactNode) => (
    <div
                  key={t.id}
                  className={`brow ${selectedId === t.id ? "brow-on" : ""} ${t.missing ? "brow-missing" : ""}`}
                  role="listitem"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/miradio-track", t.id);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedId(t.id);
                  }}
                  onDoubleClick={() => onAdd(t)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openCtx(t, e.clientX, e.clientY);
                  }}
                  title={`${t.title} — ${t.artist}`}
                >
                  <div className="bcell bcol-name">
                    <span className="brow-title">
                      {t.title}
                      {t.language && (
                        <span className="lang-flag" title={languageName(t.language)}>
                          {languageFlag(t.language)}
                        </span>
                      )}
                      {isVideoFile(t.file) && <span className="badge-video">VÍDEO</span>}
                      {t.library === "b" && <span className="chip chip-lib">B</span>}
                      {qualityBadge(t)}
                      {t.missing && <span className="badge-missing">sin archivo</span>}
                    </span>
                    <span className="brow-sub">
                      {t.artist}
                      {t.tags.length > 0 && (
                        <span className="brow-tags">
                          {t.tags.map((tag) => (
                            <span key={tag} className="chip chip-tag">{tag}</span>
                          ))}
                        </span>
                      )}
                    </span>
                  </div>
                  <span className="bcell bcol-album" title={t.album}>{t.album || "—"}</span>
                  <span className="bcell bcol-genre" title={t.genre}>{t.genre || "—"}</span>
                  {last ?? <span className="bcell bcol-dur">{fmtTime(t.durationSecs)}</span>}
                  <div className="brow-acts">
                    <button
                      type="button"
                      className="act-btn"
                      title="Añadir a la lista"
                      onClick={(e) => {
                        e.stopPropagation();
                        onAdd(t);
                      }}
                    >
                      <IconPlus size={14} />
                    </button>
                    <button
                      type="button"
                      className="act-btn"
                      title="Más acciones"
                      onClick={(e) => {
                        e.stopPropagation();
                        const r = e.currentTarget.getBoundingClientRect();
                        openCtx(t, r.right - 210, r.bottom + 4);
                      }}
                    >
                      <IconMore size={14} />
                    </button>
                  </div>
                </div>
  );

  return (
    <section className="panel browser-panel" aria-label="Música">
      <div className="panel-head">
        <h2>Música</h2>
        <span className="panel-count">
          {tracks.length} canciones · {artists.length} artistas · {blocks.length} bloques
        </span>
      </div>

      <div className="browser-tabs" role="tablist" aria-label="Modo de navegación">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={mode === m.id}
            className={`browser-tab ${mode === m.id ? "browser-tab-on" : ""}`}
            onClick={() => changeMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="browser-toolbar">
        <div className="search-box">
          <IconSearch size={14} />
          <input
            ref={searchRef}
            type="search"
            placeholder="Buscar en la biblioteca…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn btn-sm icon-only"
          onClick={onPickFiles}
          title="Importar archivos de audio o vídeo"
          aria-label="Importar archivos de audio o vídeo"
        >
          <IconImport size={14} />
        </button>
        <button
          type="button"
          className="btn btn-sm icon-only"
          onClick={() => void doScan()}
          disabled={scanning}
          title="Catalogar los archivos de la carpeta de música"
          aria-label="Catalogar los archivos de la carpeta de música"
        >
          <IconScan size={14} />
        </button>
        <button
          type="button"
          className="btn btn-sm icon-only"
          onClick={() => void doScanFolder()}
          disabled={scanning}
          title={
            scanInfo ||
            "Elegir una carpeta o un disco duro y añadir sus canciones (con subcarpetas) al catálogo general, sin copiarlas ni meterlas en bloques"
          }
          aria-label="Escanear una carpeta o un disco duro"
        >
          <IconFolder size={14} />
        </button>
        <button
          type="button"
          className="btn btn-sm icon-only"
          onClick={() => void openPlaylistImport()}
          title="Importar una lista .m3u/.m3u8 a un bloque"
          aria-label="Importar una lista a un bloque"
        >
          <IconList size={14} />
        </button>
        <button
          type="button"
          className="btn btn-sm icon-only"
          onClick={() => setAiOpen(true)}
          title="Analizar idioma y estilos con IA local"
          aria-label="Analizar idioma y estilos con IA local"
        >
          <IconSparkles size={14} />
        </button>
      </div>

      <div
        className="browser-body"
        style={{ gridTemplateColumns: `${sideWidth}px 6px minmax(0, 1fr)` }}
      >
        <aside
          className={`browser-side ${dropBlockId ? "browser-side-drop" : ""}`}
          aria-label="Filtros"
        >
          {mode === "folders" && (
            <>
              <button
                type="button"
                className={`nav-item nav-item-all ${selection === "" ? "nav-item-on" : ""}`}
                onClick={() => setSelection("")}
              >
                <IconFolder size={12} />
                <span className="nav-name">Toda la música</span>
                <span className="nav-count">{tracks.length}</span>
              </button>
              <FolderTree
                nodes={folderTree}
                depth={0}
                expanded={expanded}
                selected={selection}
                onToggle={toggleFolder}
                onSelect={setSelection}
              />
            </>
          )}

          {mode === "artists" && (
            <>
              <button
                type="button"
                className={`nav-item nav-item-all ${selection === "" ? "nav-item-on" : ""}`}
                onClick={() => setSelection("")}
              >
                <span className="nav-name">Todos los artistas</span>
                <span className="nav-count">{tracks.length}</span>
              </button>
              {artists.map(([name, count]) => (
                <button
                  key={name}
                  type="button"
                  className={`nav-item ${selection === name ? "nav-item-on" : ""}`}
                  onClick={() => setSelection(name)}
                  title={name}
                >
                  <span className="nav-name">{name}</span>
                  <span className="nav-count">{count}</span>
                </button>
              ))}
            </>
          )}

          {mode === "blocks" && (
            <>
              <button
                type="button"
                className={`nav-item nav-item-all ${selection === "" ? "nav-item-on" : ""}`}
                onClick={() => setSelection("")}
              >
                <span className="nav-name">Toda la biblioteca</span>
                <span className="nav-count">{tracks.length}</span>
              </button>
              {blockItems.map((item) => {
                const key = layoutItemKey(item);
                if (item.kind === "separator") {
                  return (
                    <div
                      key={key}
                      className={`block-sep ${dragOverBlock === key ? "block-sep-over" : ""} ${
                        draggingBlock === key ? "block-sep-dragging" : ""
                      }`}
                      draggable={renamingSeparator !== item.id}
                      onDragStart={(e) => {
                        if ((e.target as HTMLElement).closest("input,button")) {
                          e.preventDefault();
                          return;
                        }
                        setDraggingBlock(key);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", key);
                      }}
                      onDragEnd={() => {
                        setDraggingBlock("");
                        setDragOverBlock("");
                      }}
                      onDragOver={(e) => {
                        if (!draggingBlock) return;
                        e.preventDefault();
                        setDragOverBlock(key);
                      }}
                      onDrop={(e) => {
                        const from = draggingBlock || e.dataTransfer.getData("text/plain");
                        if (!from) return;
                        e.preventDefault();
                        moveBlockItem(from, key);
                        setDraggingBlock("");
                        setDragOverBlock("");
                      }}
                    >
                      <span className="block-sep-grip" aria-hidden="true">
                        ⋮⋮
                      </span>
                      {renamingSeparator === item.id ? (
                        <input
                          className="block-sep-input"
                          value={separatorValue}
                          autoFocus
                          onChange={(e) => setSeparatorValue(e.target.value)}
                          onBlur={commitSeparatorRename}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitSeparatorRename();
                            if (e.key === "Escape") setRenamingSeparator("");
                          }}
                        />
                      ) : (
                        <span className="block-sep-title" title={item.title}>
                          {item.title}
                        </span>
                      )}
                      <button
                        type="button"
                        className="nav-act"
                        title="Renombrar separador"
                        onClick={() => {
                          setRenamingSeparator(item.id);
                          setSeparatorValue(item.title);
                        }}
                      >
                        <IconEdit size={11} />
                      </button>
                      <button
                        type="button"
                        className="nav-act nav-act-danger"
                        title="Quitar separador (los bloques no se tocan)"
                        onClick={() => removeSeparator(item.id)}
                      >
                        <IconTrash size={11} />
                      </button>
                    </div>
                  );
                }
                const b = blocks.find((block) => block.id === item.id);
                if (!b) return null;
                return (
                  <div
                    key={b.id}
                    data-block-drop={b.id}
                    className={`nav-item nav-item-block ${selection === b.id ? "nav-item-on" : ""} ${
                      dropBlockId === b.id ? "nav-item-drop" : ""
                    } ${dragOverBlock === key ? "nav-item-drag-over" : ""} ${
                      draggingBlock === key ? "nav-item-dragging" : ""
                    }`}
                    draggable={renamingId !== b.id}
                    onDragStart={(e) => {
                      if ((e.target as HTMLElement).closest("input,button")) {
                        e.preventDefault();
                        return;
                      }
                      setDraggingBlock(key);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", key);
                    }}
                    onDragEnd={() => {
                      setDraggingBlock("");
                      setDragOverBlock("");
                    }}
                    onDragOver={(e) => {
                      if (!draggingBlock) return;
                      e.preventDefault();
                      setDragOverBlock(key);
                    }}
                    onDrop={(e) => {
                      const from = draggingBlock || e.dataTransfer.getData("text/plain");
                      if (!from) return;
                      e.preventDefault();
                      moveBlockItem(from, key);
                      setDraggingBlock("");
                      setDragOverBlock("");
                    }}
                    onClick={() => setSelection(b.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") setSelection(b.id);
                    }}
                    title={`${b.name} · ${blockCounts.get(b.id) ?? 0} canciones · arrastra para ordenar`}
                  >
                    {renamingId === b.id ? (
                      <input
                        className="block-rename"
                        value={renameValue}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => void submitRename()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void submitRename();
                          if (e.key === "Escape") setRenamingId("");
                        }}
                      />
                    ) : (
                      <span className="nav-name">{b.name}</span>
                    )}
                    <span className="nav-count">{blockCounts.get(b.id) ?? 0}</span>
                    <span className="nav-block-acts">
                      <button
                        type="button"
                        className={`nav-bolt ${autoBlocks.includes(b.id) ? "nav-bolt-on" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleAutoBlock(b.id);
                        }}
                        title={
                          autoBlocks.includes(b.id)
                            ? "El piloto automático elige de este bloque"
                            : "El piloto automático ignora este bloque"
                        }
                      >
                        <IconBolt size={11} />
                      </button>
                      <button
                        type="button"
                        className="nav-act"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenamingId(b.id);
                          setRenameValue(b.name);
                        }}
                        title="Renombrar bloque"
                      >
                        <IconEdit size={11} />
                      </button>
                      <button
                        type="button"
                        className="nav-act nav-act-danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          void tryDeleteBlock(b);
                        }}
                        title="Eliminar bloque (las canciones no se tocan)"
                      >
                        <IconTrash size={11} />
                      </button>
                    </span>
                  </div>
                );
              })}
              <button
                type="button"
                className={`nav-item ${selection === NONE ? "nav-item-on" : ""}`}
                onClick={() => setSelection(NONE)}
              >
                <span className="nav-name">Sin bloque</span>
                <span className="nav-count">{noBlockCount}</span>
              </button>
              <div className="block-new">
                <input
                  placeholder="Nuevo bloque…"
                  value={newBlock}
                  onChange={(e) => setNewBlock(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void tryCreateBlock();
                  }}
                />
                <button type="button" className="btn btn-sm" onClick={() => void tryCreateBlock()}>
                  <IconPlus size={13} />
                </button>
              </div>
              <div className="block-new">
                <input
                  placeholder="Título del separador…"
                  value={newSeparator}
                  onChange={(e) => setNewSeparator(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addSeparator();
                  }}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  title="Añadir separador"
                  onClick={addSeparator}
                >
                  <IconPlus size={13} />
                </button>
              </div>
            </>
          )}

          {mode === "genres" && (
            <>
              <button
                type="button"
                className={`nav-item nav-item-all ${selection === "" ? "nav-item-on" : ""}`}
                onClick={() => setSelection("")}
              >
                <span className="nav-name">Todos los estilos</span>
                <span className="nav-count">{tracks.length}</span>
              </button>
              {genres.map(([name, count]) => (
                <button
                  key={name}
                  type="button"
                  className={`nav-item ${selection === name ? "nav-item-on" : ""}`}
                  onClick={() => setSelection(name)}
                  title={name}
                >
                  <span className="nav-name">{name}</span>
                  <span className="nav-count">{count}</span>
                </button>
              ))}
              <button
                type="button"
                className={`nav-item ${selection === NONE ? "nav-item-on" : ""}`}
                onClick={() => setSelection(NONE)}
              >
                <span className="nav-name">Sin estilo</span>
                <span className="nav-count">{tracks.filter((t) => !t.genre.trim()).length}</span>
              </button>
            </>
          )}

          {mode === "tags" && (
            <>
              <button
                type="button"
                className={`nav-item nav-item-all ${selection === "" ? "nav-item-on" : ""}`}
                onClick={() => setSelection("")}
              >
                <IconTag size={12} />
                <span className="nav-name">Todas las etiquetas</span>
                <span className="nav-count">{tracks.length}</span>
              </button>
              {tags.length === 0 && (
                <p className="hint side-hint">
                  Las etiquetas se añaden en «Editar metadatos», separadas por comas.
                </p>
              )}
              {tags.map(([name, count]) => (
                <button
                  key={name}
                  type="button"
                  className={`nav-item ${selection === name ? "nav-item-on" : ""}`}
                  onClick={() => setSelection(name)}
                  title={name}
                >
                  <span className="nav-name">{name}</span>
                  <span className="nav-count">{count}</span>
                </button>
              ))}
              {tags.length > 0 && (
                <button
                  type="button"
                  className={`nav-item ${selection === NONE ? "nav-item-on" : ""}`}
                  onClick={() => setSelection(NONE)}
                >
                  <span className="nav-name">Sin etiquetas</span>
                  <span className="nav-count">{noTagCount}</span>
                </button>
              )}
            </>
          )}
        </aside>

        <div
          className="browser-split"
          role="separator"
          aria-orientation="vertical"
          aria-label="Ancho de la lista de carpetas y bloques"
          tabIndex={0}
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            const width = Math.max(120, Math.min(480, sideWidth + (e.key === "ArrowLeft" ? -16 : 16)));
            setSideWidth(width);
            try {
              localStorage.setItem(SIDE_WIDTH_KEY, String(width));
            } catch {
              /* sin almacenamiento */
            }
          }}
        />

        <div className="browser-main">
          <div className="browser-crumbs">
            <span className="crumb">{selectionLabel}</span>
            <span className="crumb-count">{filtered.length} canciones</span>
          </div>

          <div className="browser-cols">
            <button type="button" className="bcol bcol-name" onClick={() => toggleSort("title")}>
              Nombre
              {sort.key === "title" && <span className="sort-mark">{sort.dir === 1 ? "↑" : "↓"}</span>}
            </button>
            <button type="button" className="bcol" onClick={() => toggleSort("album")}>
              Álbum
              {sort.key === "album" && <span className="sort-mark">{sort.dir === 1 ? "↑" : "↓"}</span>}
            </button>
            <button type="button" className="bcol bcol-genre" onClick={() => toggleSort("genre")}>
              Estilo
              {sort.key === "genre" && <span className="sort-mark">{sort.dir === 1 ? "↑" : "↓"}</span>}
            </button>
            <button
              type="button"
              className="bcol bcol-dur"
              onClick={() => toggleSort("duration")}
              title={mode === "history" ? "Hora en que sonó" : "Duración"}
            >
              {mode === "history" ? "Emitida" : "Dur."}
              {sort.key === "duration" && <span className="sort-mark">{sort.dir === 1 ? "↑" : "↓"}</span>}
            </button>
          </div>

          {mode === "history" ? (
            <div className="browser-rows" role="list" onClick={() => setSelectedId("")}>
              {playedTracks.length === 0 ? (
                <div className="empty-note">
                  Todavía no ha sonado ninguna canción. Aquí se verán las últimas que se han
                  emitido.
                </div>
              ) : (
                playedTracks.map(({ track, playedAt }) =>
                  rowFor(
                    track,
                    <span className="bcell bcol-dur brow-when">
                      {new Date(playedAt * 1000).toLocaleString("es-ES", {
                        day: "2-digit",
                        month: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>,
                  ),
                )
              )}
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty-note">
              {tracks.length === 0
                ? "La biblioteca está vacía. Importa canciones, escanea tu carpeta de música o importa una lista M3U."
                : "No hay canciones con este filtro."}
            </div>
          ) : (
            <div className="browser-rows" role="list" onClick={() => setSelectedId("")}>
              {filtered.map((t) => rowFor(t))}
            </div>
          )}
        </div>
      </div>

      {ctx && (
        <div
          className="ctx-backdrop"
          onClick={closeCtx}
          onContextMenu={(e) => {
            e.preventDefault();
            closeCtx();
          }}
        >
          <div
            className="ctx-menu"
            style={{ left: ctx.x, top: ctx.y }}
            onClick={(e) => e.stopPropagation()}
            role="menu"
          >
            <div className="ctx-title" title={ctx.track.title}>{ctx.track.title}</div>
            <button
              type="button"
              className="ctx-item"
              onClick={() => {
                onAdd(ctx.track);
                closeCtx();
              }}
            >
              <IconPlus size={13} /> Añadir a la lista
            </button>
            <button
              type="button"
              className="ctx-item"
              onClick={() => {
                void openProperties(ctx.track);
                closeCtx();
              }}
            >
              <IconTag size={13} /> Propiedades
            </button>
            <button
              type="button"
              className="ctx-item"
              onClick={() => {
                openEditor(ctx.track);
                closeCtx();
              }}
            >
              <IconEdit size={13} /> Editar metadatos
            </button>
            <button
              type="button"
              className="ctx-item"
              onClick={() => {
                onEditCuts(ctx.track);
                closeCtx();
              }}
            >
              <IconWave size={13} /> Cortes y puntos
            </button>
            <button
              type="button"
              className="ctx-item"
              onClick={() => {
                void doRelink(ctx.track.id);
                closeCtx();
              }}
            >
              <IconLink size={13} /> Relinkar archivo
            </button>
            <div className="ctx-sep" />
            <button
              type="button"
              className="ctx-item ctx-danger"
              onClick={() => {
                onDelete(ctx.track);
                closeCtx();
              }}
            >
              <IconTrash size={13} /> Quitar de la biblioteca
            </button>
          </div>
        </div>
      )}

      {propsId && (
        <TrackDetailsModal
          trackId={propsId}
          onClose={() => setPropsId("")}
          onEdit={(id) => {
            const t = tracks.find((x) => x.id === id);
            setPropsId("");
            if (t) openEditor(t);
          }}
        />
      )}

      {edit && deezerOpen && (
        <DeezerSearch
          initialQuery={`${edit.artist} ${edit.title}`.trim()}
          onClose={() => setDeezerOpen(false)}
          onPick={(d) => {
            setEdit((s) =>
              s
                ? {
                    ...s,
                    title: d.title || s.title,
                    artist: d.artist || s.artist,
                    album: d.album || s.album,
                    year: d.year || s.year,
                    genre: d.genre || s.genre,
                    coverChange:
                      d.coverBig || d.cover
                        ? { kind: "url", source: d.coverBig || d.cover }
                        : s.coverChange,
                  }
                : s,
            );
            setDeezerOpen(false);
          }}
          showToast={showToast}
        />
      )}

      {edit && (
        <div className="modal-backdrop" onClick={() => setEdit(null)}>
          <div
            className="modal modal-wide"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Editar canción"
          >
            <div className="modal-head">
              <h3>Editar canción</h3>
              <button type="button" className="ghost-btn" onClick={() => setEdit(null)}>
                Cerrar
              </button>
            </div>
            <div className="modal-body">
              <button
                type="button"
                className="btn btn-sm"
                style={{ alignSelf: "flex-start" }}
                onClick={() => setDeezerOpen(true)}
                title="Buscar esta canción en Deezer y rellenar sus datos"
              >
                <IconSearch size={14} />
                Rellenar desde Deezer
              </button>
              <div className="edit-cover">
                <div className="edit-cover-img">
                  {(() => {
                    const cc = edit.coverChange;
                    const src =
                      cc?.kind === "clear"
                        ? ""
                        : cc?.kind === "url"
                          ? cc.source
                          : cc?.kind === "file"
                            ? trackUrl({ file: cc.source })
                            : edit.cover
                              ? trackUrl({ file: edit.cover })
                              : "";
                    return src ? <img src={src} alt="Carátula" /> : <span className="hint">Sin carátula</span>;
                  })()}
                </div>
                <div className="edit-cover-actions">
                  <span className="field-label">Carátula</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={async () => {
                      const path = await pickCoverImage();
                      if (path) setEdit((s) => (s ? { ...s, coverChange: { kind: "file", source: path } } : s));
                    }}
                  >
                    Cambiar…
                  </button>
                  {(edit.cover || (edit.coverChange && edit.coverChange.kind !== "clear")) && (
                    <button
                      type="button"
                      className="ghost-btn ghost-danger"
                      onClick={() => setEdit((s) => (s ? { ...s, coverChange: { kind: "clear" } } : s))}
                    >
                      Quitar
                    </button>
                  )}
                  <span className="hint">Se aplica a todo el álbum.</span>
                </div>
              </div>
              <label className="field">
                <span className="field-label">Título</span>
                <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">Artista</span>
                <input value={edit.artist} onChange={(e) => setEdit({ ...edit, artist: e.target.value })} />
              </label>
              <div className="field-row">
                <label className="field">
                  <span className="field-label">Álbum</span>
                  <input value={edit.album} onChange={(e) => setEdit({ ...edit, album: e.target.value })} />
                </label>
                <label className="field">
                  <span className="field-label">Estilo</span>
                  <input value={edit.genre} onChange={(e) => setEdit({ ...edit, genre: e.target.value })} />
                </label>
                <label className="field field-year">
                  <span className="field-label">Año</span>
                  <input value={edit.year} onChange={(e) => setEdit({ ...edit, year: e.target.value })} />
                </label>
              </div>
              <label className="field">
                <span className="field-label">Idioma</span>
                <select value={edit.language} onChange={(e) => setEdit({ ...edit, language: e.target.value })}>
                  <option value="">Sin indicar</option>
                  {[...new Set([...languages, ...(edit.language ? [edit.language] : [])])].map((c) => (
                    <option key={c} value={c}>
                      {languageFlag(c)} {languageName(c)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Etiquetas</span>
                <input
                  value={edit.tagsText}
                  placeholder="separadas por comas: navidad, instrumental"
                  onChange={(e) => setEdit({ ...edit, tagsText: e.target.value })}
                />
              </label>

              <div className="field">
                <span className="field-label">Bloques musicales</span>
                <div className="edit-blocks">
                  {blocks.length === 0 && (
                    <span className="hint">Crea bloques en la pestaña «Bloques» para clasificar esta canción.</span>
                  )}
                  {blocks.map((b) => {
                    const on = edit.blocks.includes(b.id);
                    return (
                      <button
                        key={b.id}
                        type="button"
                        className={`chip chip-toggle ${on ? "chip-on" : ""}`}
                        onClick={() =>
                          setEdit({
                            ...edit,
                            blocks: on ? edit.blocks.filter((x) => x !== b.id) : [...edit.blocks, b.id],
                          })
                        }
                      >
                        {b.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="edit-actions">
                {edit.busy ? (
                  <span className="hint">Trabajando…</span>
                ) : (
                  <>
                    <button type="button" className="btn btn-sm" onClick={() => void doRelink(edit.id)}>
                      <IconLink size={13} /> Relinkar archivo
                    </button>
                    <span className="spacer" />
                    <button type="button" className="btn btn-sm" onClick={() => void saveEdit()}>
                      Guardar
                    </button>
                  </>
                )}
              </div>
              <p className="hint">
                La canción vive en la biblioteca aunque su archivo se mueva o desaparezca:
                con «Relinkar archivo» la vuelves a conectar.
              </p>
            </div>
          </div>
        </div>
      )}

      {imp && (
        <div className="modal-backdrop" onClick={() => setImp(null)}>
          <div
            className="modal modal-wide"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Importar lista a un bloque"
          >
            <div className="modal-head">
              <h3>Importar lista a un bloque</h3>
              <button type="button" className="ghost-btn" onClick={() => setImp(null)}>
                Cerrar
              </button>
            </div>
            <div className="modal-body">
              <p className="hint">
                <strong>{imp.fileName}</strong>
                <br />
                Las canciones que ya estén en la biblioteca se añaden al bloque; las que no,
                se catalogan.
              </p>

              {imp.report ? (
                <>
                  <fieldset className="fieldset">
                    <legend>Resultado</legend>
                    <p className="report-line">
                      Bloque <strong>«{imp.report.blockName}»</strong>:{" "}
                      {imp.report.matched + imp.report.added} de {imp.report.total} canciones.
                    </p>
                    <p className="hint">
                      {imp.report.matched} ya estaban en la biblioteca · {imp.report.added} nuevas
                      catalogadas
                      {imp.report.streams > 0 ? ` · ${imp.report.streams} streams ignorados` : ""}
                    </p>
                    {imp.report.missing.length > 0 && (
                      <>
                        <p className="hint report-warn">
                          {imp.report.missing.length} archivos de la lista no existen en el disco:
                        </p>
                        <div className="missing-list">
                          {imp.report.missing.map((m) => (
                            <span key={m} className="missing-item" title={m}>{m}</span>
                          ))}
                        </div>
                      </>
                    )}
                  </fieldset>
                  <div className="edit-actions">
                    <span className="spacer" />
                    <button type="button" className="btn btn-sm" onClick={() => setImp(null)}>
                      Hecho
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <fieldset className="fieldset">
                    <legend>Bloque de destino</legend>
                    <label className="radio-row">
                      <input
                        type="radio"
                        checked={imp.mode === "existing"}
                        disabled={blocks.length === 0}
                        onChange={() => setImp({ ...imp, mode: "existing" })}
                      />
                      <span>Añadir a un bloque existente</span>
                      <select
                        value={imp.blockId}
                        disabled={imp.mode !== "existing" || blocks.length === 0}
                        onChange={(e) => setImp({ ...imp, blockId: e.target.value })}
                      >
                        {blocks.map((b) => (
                          <option key={b.id} value={b.id}>{b.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="radio-row">
                      <input
                        type="radio"
                        checked={imp.mode === "new"}
                        onChange={() => setImp({ ...imp, mode: "new" })}
                      />
                      <span>Crear un bloque nuevo</span>
                      <input
                        type="text"
                        value={imp.newName}
                        disabled={imp.mode !== "new"}
                        onChange={(e) => setImp({ ...imp, newName: e.target.value })}
                      />
                    </label>
                    <p className="hint">Si ya existe un bloque con ese nombre, se reutiliza.</p>
                  </fieldset>

                  <fieldset className="fieldset">
                    <legend>Archivos</legend>
                    <label className="check-field">
                      <input
                        type="checkbox"
                        checked={imp.copy}
                        onChange={(e) => setImp({ ...imp, copy: e.target.checked })}
                      />
                      Copiar los archivos a la carpeta de música
                    </label>
                    <p className="hint">
                      Desmarcado (recomendado si tu música ya está organizada): las canciones
                      enlazan el archivo en su sitio, sin duplicarlo.
                    </p>
                  </fieldset>

                  <div className="edit-actions">
                    {imp.busy ? (
                      <span className="hint">Importando… puede tardar si hay muchas canciones.</span>
                    ) : (
                      <>
                        <span className="spacer" />
                        <button type="button" className="btn btn-sm" onClick={() => void submitImport()}>
                          Importar
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {aiOpen && (
        <AiMetadataModal
          tracks={filtered}
          ai={ai}
          onClose={() => setAiOpen(false)}
          onSaved={onTrackSaved}
          showToast={showToast}
        />
      )}
    </section>
  );
}
