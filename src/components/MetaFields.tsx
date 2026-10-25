import type { StreamMeta } from "../types";
import { pickImageFile, trackUrl } from "../api";

export const EMPTY_STREAM_META: StreamMeta = {
  title: "",
  artist: "",
  album: "",
  year: "",
  genre: "",
  comment: "",
  cover: "",
};

/** Metadatos que se muestran (nowplaying, API, notificaciones) al emitir. */
export function MetaFields({
  meta,
  onChange,
  legend = "Metadatos al emitirse",
}: {
  meta: StreamMeta;
  onChange: (meta: StreamMeta) => void;
  legend?: string;
}) {
  const set = (patch: Partial<StreamMeta>) => onChange({ ...meta, ...patch });
  const field = (key: keyof StreamMeta, label: string, placeholder = "") => (
    <label className="field" key={key}>
      <span className="field-label">{label}</span>
      <input
        type="text"
        value={meta[key]}
        placeholder={placeholder}
        maxLength={200}
        onChange={(e) => set({ [key]: e.target.value })}
      />
    </label>
  );
  return (
    <fieldset className="fieldset">
      <legend>{legend}</legend>
      <div className="stream-meta">
        <button
          type="button"
          className="stream-cover"
          title="Elegir la portada"
          onClick={() => void pickImageFile().then((path) => path && set({ cover: path }))}
        >
          {meta.cover ? <img src={trackUrl({ file: meta.cover })} alt="" /> : <span>Elegir portada</span>}
        </button>
        <div className="stream-meta-fields">
          <div className="field-row">
            {field("title", "Título", "El que se verá al emitirse")}
            {field("artist", "Artista", "Emisora o intérprete")}
          </div>
          <div className="field-row">
            {field("album", "Álbum")}
            {field("year", "Año")}
            {field("genre", "Género")}
          </div>
          {field("comment", "Comentario")}
          {meta.cover && (
            <button type="button" className="ghost-btn" onClick={() => set({ cover: "" })}>
              Quitar portada
            </button>
          )}
        </div>
      </div>
      <p className="hint">
        Si dejas los campos vacíos se usan los metadatos de la canción. La portada también se envía
        a las notificaciones y a la ventana de vídeo.
      </p>
    </fieldset>
  );
}
