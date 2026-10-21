import { deleteProgramCover, importProgramCover, pickImageFile, trackUrl } from "../api";
import { IconNote, IconPlus, IconTrash } from "../icons";
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
 */
export function ProgramsTab({ settings, onChange, showToast }: ProgramsTabProps) {
  const programs = settings.programs ?? [];

  const update = (id: string, patch: Partial<Program>) => {
    onChange({
      ...settings,
      programs: programs.map((program) =>
        program.id === id ? { ...program, ...patch } : program,
      ),
    });
  };

  const add = () => {
    const program = newProgram();
    onChange({ ...settings, programs: [...programs, program] });
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

  return (
    <>
      <fieldset className="fieldset">
        <legend>Programas</legend>
        <p className="hint">
          Prepara aquí los programas con antelación: título, portada y hora de inicio. Con el
          modo LIVE activado, la barra auxiliar muestra el programa que está en antena y sus
          metadatos sustituyen a los de la canción (archivo nowplaying y portada).
        </p>
        <div className="prog-actions">
          <button type="button" className="btn btn-sm" onClick={add}>
            <IconPlus size={14} />
            Nuevo programa
          </button>
        </div>
        {programs.length === 0 && (
          <p className="hint">Todavía no hay programas. Crea el primero para poder usarlo en directo.</p>
        )}
      </fieldset>

      {programs.map((program) => (
        <fieldset className="fieldset prog-card" key={program.id}>
          <legend>
            <label className="check-field">
              <input
                type="checkbox"
                checked={program.enabled}
                onChange={(e) => update(program.id, { enabled: e.target.checked })}
              />
              {program.name.trim() || "Programa sin título"}
            </label>
          </legend>
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
                className="ghost-btn"
                onClick={() =>
                  onChange({ ...settings, liveMode: true, liveProgramId: program.id })
                }
                title="Activar el modo LIVE con este programa en antena"
              >
                Al aire
              </button>
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
        </fieldset>
      ))}
    </>
  );
}
