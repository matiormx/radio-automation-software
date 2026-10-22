import { useRef, useState } from "react";
import { deleteProgramCover, importProgramCover, pickImageFile, trackUrl } from "../api";
import { IconChevron, IconNote, IconPlus, IconTrash } from "../icons";
import type { Program, Settings } from "../types";

interface ProgramsTabProps {
  settings: Settings;
  onChange: (s: Settings) => void;
  showToast: (msg: string) => void;
}

function newProgram(): Program {
  return {
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: "",
    subtitle: "",
    cover: "",
    startsAt: "",
    enabled: true,
  };
}

/**
 * Programas de emisión: se preparan con antelación (título, portada y hora
 * de inicio). En modo LIVE, el programa seleccionado sustituye los metadatos
 * de la canción que suena.
 *
 * La lista va compacta (una línea por programa); se despliega uno para
 * editarlo y se reordenan arrastrando el asa. Los nuevos se añaden arriba.
 */
export function ProgramsTab({ settings, onChange, showToast }: ProgramsTabProps) {
  const programs = settings.programs ?? [];
  const [open, setOpen] = useState<Set<string>>(new Set());
  // Orden provisional mientras se arrastra; se guarda una sola vez al soltar.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const topRef = useRef<HTMLDivElement | null>(null);

  const byId = new Map(programs.map((program) => [program.id, program]));
  const shown = dragOrder
    ? dragOrder.flatMap((id) => {
        const program = byId.get(id);
        return program ? [program] : [];
      })
    : programs;

  const update = (id: string, patch: Partial<Program>) => {
    onChange({
      ...settings,
      programs: programs.map((program) =>
        program.id === id ? { ...program, ...patch } : program,
      ),
    });
  };

  const toggle = (id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // El programa nuevo va arriba, desplegado, y la ventana sube para verlo
  // aunque se estuviera mirando el final de la lista.
  const add = () => {
    const program = newProgram();
    onChange({ ...settings, programs: [program, ...programs] });
    setOpen((prev) => new Set(prev).add(program.id));
    window.requestAnimationFrame(() => {
      topRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  };

  const remove = async (program: Program) => {
    if (program.cover) {
      try {
        await deleteProgramCover(program.cover);
      } catch {
        /* la imagen ya no esta */
      }
    }
    const rest = programs.filter((item) => item.id !== program.id);
    onChange({
      ...settings,
      programs: rest,
      liveProgramId: settings.liveProgramId === program.id ? "" : settings.liveProgramId,
    });
    showToast(`Programa «${program.name || "sin título"}» eliminado`);
  };

  const pickCover = async (program: Program) => {
    try {
      const picked = await pickImageFile();
      if (!picked) return;
      const cover = await importProgramCover(picked);
      if (program.cover && program.cover !== cover) {
        void deleteProgramCover(program.cover).catch(() => undefined);
      }
      update(program.id, { cover });
      showToast("Portada guardada");
    } catch (error) {
      showToast(`No se pudo guardar la portada: ${String(error)}`);
    }
  };

  // ---- reordenar arrastrando el asa (con el puntero, no con arrastrar y soltar
  // del navegador, que la ventana de la app intercepta para los archivos) ----

  const gripDown = (e: React.PointerEvent<HTMLElement>, id: string) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragId(id);
    setDragOrder(programs.map((program) => program.id));
  };

  const gripMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!dragId || !dragOrder) return;
    const others = dragOrder.filter((id) => id !== dragId);
    let index = 0;
    for (const id of others) {
      const rect = rowRefs.current.get(id)?.getBoundingClientRect();
      if (rect && e.clientY > rect.top + rect.height / 2) index += 1;
    }
    const next = [...others.slice(0, index), dragId, ...others.slice(index)];
    if (next.some((id, i) => id !== dragOrder[i])) setDragOrder(next);
  };

  const gripUp = (e: React.PointerEvent<HTMLElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ya soltado */
    }
    if (dragOrder && dragOrder.some((id, i) => id !== programs[i]?.id)) {
      onChange({
        ...settings,
        programs: dragOrder.flatMap((id) => {
          const program = byId.get(id);
          return program ? [program] : [];
        }),
      });
    }
    setDragId(null);
    setDragOrder(null);
  };

  return (
    <>
      <div ref={topRef} />
      <fieldset className="fieldset">
        <legend>Programas</legend>
        <p className="hint">
          Prepara aquí los programas con antelación: título, portada y hora de inicio. Con el
          modo LIVE activado, la barra auxiliar muestra el programa que está en antena y sus
          metadatos sustituyen a los de la canción (archivo nowplaying y portada). Arrastra el asa
          para ordenarlos y despliega uno para editarlo.
        </p>
        {programs.length === 0 && (
          <p className="hint">Todavía no hay programas. Crea el primero para poder usarlo en directo.</p>
        )}
      </fieldset>

      <div className="prog-list">
        {shown.map((program) => {
          const expanded = open.has(program.id);
          const live = settings.liveMode && settings.liveProgramId === program.id;
          return (
            <section
              key={program.id}
              ref={(el) => {
                if (el) rowRefs.current.set(program.id, el);
                else rowRefs.current.delete(program.id);
              }}
              className={`prog-item ${expanded ? "prog-item-open" : ""} ${
                dragId === program.id ? "prog-item-drag" : ""
              }`}
            >
              <div className="prog-line">
                <span
                  className="prog-grip"
                  role="button"
                  aria-label="Arrastrar para ordenar"
                  title="Arrastra para ordenar"
                  onPointerDown={(e) => gripDown(e, program.id)}
                  onPointerMove={gripMove}
                  onPointerUp={gripUp}
                  onPointerCancel={gripUp}
                >
                  ⋮⋮
                </span>
                <input
                  type="checkbox"
                  checked={program.enabled}
                  title="Programa activo"
                  onChange={(e) => update(program.id, { enabled: e.target.checked })}
                />
                <span className="prog-thumb">
                  {program.cover ? <img src={trackUrl({ file: program.cover })} alt="" /> : <IconNote size={14} />}
                </span>
                <button
                  type="button"
                  className="prog-title"
                  onClick={() => toggle(program.id)}
                  title={expanded ? "Plegar" : "Desplegar para editar"}
                >
                  <strong>{program.name.trim() || "Programa sin título"}</strong>
                  {program.subtitle && <span>{program.subtitle}</span>}
                </button>
                {live && <span className="prog-live">AL AIRE</span>}
                <span className="prog-time">{program.startsAt || "—"}</span>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => onChange({ ...settings, liveMode: true, liveProgramId: program.id })}
                  title="Activar el modo LIVE con este programa en antena"
                >
                  Al aire
                </button>
                <button
                  type="button"
                  className={`ghost-btn prog-chevron ${expanded ? "prog-chevron-open" : ""}`}
                  onClick={() => toggle(program.id)}
                  aria-expanded={expanded}
                  title={expanded ? "Plegar" : "Desplegar para editar"}
                >
                  <IconChevron size={12} />
                </button>
              </div>

              {expanded && (
                <div className="prog-row">
                  <div className="prog-cover">
                    {program.cover ? (
                      <img src={trackUrl({ file: program.cover })} alt="" />
                    ) : (
                      <IconNote size={20} />
                    )}
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={() => void pickCover(program)}
                      title="Elegir la portada del programa"
                    >
                      Portada
                    </button>
                  </div>
                  <div className="prog-fields">
                    <label className="field">
                      <span className="field-label">Título</span>
                      <input
                        type="text"
                        value={program.name}
                        maxLength={80}
                        placeholder="Noche de Rock"
                        onChange={(e) => update(program.id, { name: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">Bajada</span>
                      <input
                        type="text"
                        value={program.subtitle}
                        maxLength={120}
                        placeholder="Lo mejor del rock clásico"
                        onChange={(e) => update(program.id, { subtitle: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">Empieza a las</span>
                      <span className="field-unit">
                        <input
                          type="time"
                          value={program.startsAt}
                          onChange={(e) => update(program.id, { startsAt: e.target.value })}
                        />
                      </span>
                    </label>
                  </div>
                  <div className="prog-actions">
                    <button
                      type="button"
                      className="ghost-btn prog-del"
                      onClick={() => void remove(program)}
                      title="Eliminar el programa"
                    >
                      <IconTrash size={15} />
                    </button>
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>

      {/* Siempre a la vista, aunque se baje hasta el final de la lista */}
      <div className="prog-addbar">
        <button type="button" className="btn btn-sm btn-accent" onClick={add}>
          <IconPlus size={14} />
          Nuevo programa
        </button>
      </div>
    </>
  );
}
