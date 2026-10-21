import { trackUrl } from "../api";
import { IconNote } from "../icons";
import type { Program } from "../types";

interface LiveBarProps {
  programs: Program[];
  activeId: string;
  onSelect: (id: string) => void;
  onOpenPrograms: () => void;
}

/**
 * Barra auxiliar del modo LIVE: muestra la portada y el título del programa
 * que está en antena y permite cambiar de programa al momento. Los metadatos
 * del programa sustituyen a los de la canción en el nowplaying.
 */
export function LiveBar({ programs, activeId, onSelect, onOpenPrograms }: LiveBarProps) {
  const active = programs.find((program) => program.id === activeId) ?? null;
  const others = programs.filter((program) => program.id !== activeId);

  return (
    <div className="livebar" role="region" aria-label="Programa en directo">
      <div className="livebar-cover">
        {active?.cover ? (
          <img src={trackUrl({ file: active.cover })} alt="" />
        ) : (
          <IconNote size={22} />
        )}
      </div>

      <div className="livebar-info">
        <span className="livebar-tag">EN DIRECTO</span>
        <span className="livebar-name">{active?.name || "Sin programa"}</span>
        {active?.subtitle && <span className="livebar-sub">{active.subtitle}</span>}
        {active?.startsAt && (
          <span className="livebar-time">Empieza a las {active.startsAt}</span>
        )}
      </div>

      {others.length > 0 && (
        <div className="livebar-list" aria-label="Programas preparados">
          {others.map((program) => (
            <button
              key={program.id}
              type="button"
              className="livebar-chip"
              title={`Poner «${program.name}» en antena`}
              onClick={() => onSelect(program.id)}
            >
              {program.cover ? (
                <img src={trackUrl({ file: program.cover })} alt="" />
              ) : (
                <span className="livebar-chip-txt">
                  {program.name.trim().slice(0, 2).toUpperCase() || "•"}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      <button type="button" className="ghost-btn" onClick={onOpenPrograms}>
        Programas
      </button>
    </div>
  );
}
