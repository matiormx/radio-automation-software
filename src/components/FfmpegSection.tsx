import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ffmpegInfo, ffmpegUpdate, openExternal, type FfmpegInfo, type FfmpegProgress } from "../api";

const PHASE: Record<string, string> = {
  comprobando: "Comprobando la última versión…",
  descargando: "Descargando",
  verificando: "Comprobando la firma…",
  instalando: "Instalando…",
};

const SOURCE: Record<string, string> = {
  auto: "descargado y mantenido por OmniCaster",
  manual: "puesto a mano (OmniCaster no lo toca)",
  system: "el del sistema (PATH)",
  none: "no hay",
};

/** FFmpeg: cuál se usa, de dónde sale y su actualización automática. */
export function FfmpegSection({ showToast }: { showToast: (msg: string) => void }) {
  const [info, setInfo] = useState<FfmpegInfo | null>(null);
  const [prog, setProg] = useState<FfmpegProgress | null>(null);

  const load = useCallback(() => {
    void ffmpegInfo()
      .then((i) => {
        setInfo(i);
        if (i.progress) setProg(i.progress);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const off = listen<FfmpegProgress>("ffmpeg://progress", (e) => {
      setProg(e.payload);
      if (!e.payload.busy) load();
    });
    return () => {
      void off.then((f) => f());
    };
  }, [load]);

  const busy = !!prog?.busy;
  const installedAt = info?.managed?.installedAt ? new Date(info.managed.installedAt * 1000).toLocaleDateString() : "";
  const lastCheck = info?.managed?.lastCheck ? new Date(info.managed.lastCheck * 1000).toLocaleDateString() : "";

  return (
    <fieldset className="fieldset">
      <legend>FFmpeg (emisiones, vídeo y conversiones)</legend>
      <p className="hint">
        {info?.canDownload
          ? "OmniCaster descarga FFmpeg sola si no lo encuentra y busca versión nueva cada semana. Si pones tu propio ffmpeg.exe junto a OmniCaster.exe, se usa ese."
          : "En este sistema se usa el FFmpeg instalado."}
      </p>
      {info && (
        <p className="hint">
          En uso: <strong>{info.version || "ninguno"}</strong>
          {info.source !== "none" && <> · {SOURCE[info.source] ?? info.source}</>}
          {info.source === "auto" && installedAt && <> · instalado el {installedAt}</>}
          {info.source === "auto" && lastCheck && <> · comprobado el {lastCheck}</>}
        </p>
      )}
      <div className="update-actions">
        {info?.canDownload && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() =>
              void ffmpegUpdate().catch((e) => showToast(String(e)))
            }
          >
            {busy
              ? `${PHASE[prog?.phase ?? ""] ?? "Trabajando…"}${prog?.phase === "descargando" ? ` ${Math.round((prog.fraction || 0) * 100)} %` : ""}`
              : info?.source === "none"
                ? "Descargar FFmpeg"
                : "Buscar actualización de FFmpeg"}
          </button>
        )}
        <button
          type="button"
          className="ghost-btn"
          onClick={() => void openExternal("https://github.com/BtbN/FFmpeg-Builds").catch(() => undefined)}
        >
          Origen y licencia
        </button>
      </div>
      {busy && prog?.phase === "descargando" && (
        <div className="ff-progress">
          <div style={{ width: `${Math.round((prog.fraction || 0) * 100)}%` }} />
        </div>
      )}
      {!busy && prog?.done && <p className="hint">{prog.done}</p>}
      {!busy && prog?.error && <p className="hint update-error">{prog.error}</p>}
      <p className="hint">
        FFmpeg es software libre (GPL), de las compilaciones oficiales para Windows de BtbN/FFmpeg-Builds. Va como
        programa aparte; su código está en ffmpeg.org.
      </p>
    </fieldset>
  );
}
