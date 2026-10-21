export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  year: string;
  durationSecs: number;
  /** Ruta absoluta del archivo vinculado */
  file: string;
  originalName: string;
  blocks: string[];
  tags: string[];
  /** Biblioteca a la que pertenece la ficha: "a" o "b" */
  library: "a" | "b";
  /** Sonoridad integrada medida (LUFS) */
  lufs: number | null;
  /** Ganancia calculada para el objetivo, limitada por el pico */
  gainDb: number | null;
  truePeakDb: number | null;
  /** La ganancia se recortó para respetar el techo de pico */
  limited: boolean;
  trimStart: number;
  trimEnd: number | null;
  autoTrimStart: number;
  autoTrimEnd: number | null;
  trimManual: boolean;
  analyzedAt: number;
  /** Se calcula al listar: el registro vive aunque falte el archivo */
  missing: boolean;
  cover: string;
}

export function effectiveDuration(t: Track): number {
  const start = Math.max(0, t.trimStart || 0);
  const end = t.trimEnd ?? t.durationSecs;
  return Math.max(0, end - start);
}

export interface AnalysisResult {
  id: string;
  durationSecs: number;
  lufs: number | null;
  gainDb: number | null;
  truePeakDb: number | null;
  limited: boolean;
  trimStart: number;
  trimEnd: number | null;
  autoTrimStart: number;
  autoTrimEnd: number | null;
  trimManual: boolean;
  analyzedAt: number;
}

export interface Waveform {
  durationSecs: number;
  sampleRate: number;
  peaks: number[];
}

export interface Block {
  id: string;
  name: string;
  trackCount: number;
}

export interface TrackPatch {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  year?: string;
  tags?: string[];
}

export interface TrackDetails {
  id: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  year: string;
  durationSecs: number;
  file: string;
  originalName: string;
  blocks: string[];
  blockNames: string[];
  tags: string[];
  missing: boolean;
  fileSize: number;
  format: string;
  bitrateKbps: number | null;
  sampleRate: number | null;
  channels: number | null;
  bitDepth: number | null;
  library: "a" | "b";
  lufs: number | null;
  gainDb: number | null;
  truePeakDb: number | null;
  trimStart: number;
  trimEnd: number | null;
  cover: string;
}

export interface PlaylistImportReport {
  blockId: string;
  blockName: string;
  total: number;
  matched: number;
  added: number;
  missing: string[];
  streams: number;
}

export interface Playlist {
  id: string;
  name: string;
  trackIds: string[];
}

export interface PlaylistRow {
  id: string;
  title: string;
  artist: string;
  durationSecs: number;
  cover: string;
}

export type CampaignKind = "ads" | "jingle";

export interface Campaign {
  id: string;
  name: string;
  kind: CampaignKind;
  enabled: boolean;
  days: number[];
  times: string[];
  hourly: boolean;
  minute: number;
  /** Inicio de la campaña (fecha y hora local); "" = sin límite */
  startAt: string;
  /** Fin de la campaña (fecha y hora local); "" = permanente */
  endAt: string;
  trackIds: string[];
  cursor: number;
  lastFired: string;
}

export type StationEventKind = "auto" | "insert";
export type StationEventSource = "block" | "library";
export type StationEventTimeout = "force" | "cancel";

export interface StationEvent {
  id: string;
  name: string;
  enabled: boolean;
  kind: StationEventKind;
  days: number[];
  /** Hora de inicio de la franja (auto) o de la inserción (insert), HH:MM */
  start: string;
  /** Fin de la franja AutoDJ, HH:MM; puede cruzar medianoche */
  end: string;
  sourceKind: StationEventSource;
  /** id de bloque o "a"/"b" */
  sourceId: string;
  /** Pista que se inserta como siguiente */
  trackId: string;
  /** Segundos de espera máxima antes de lanzar o cancelar la inserción */
  maxWaitSecs: number;
  onTimeout: StationEventTimeout;
  /** Última emisión "YYYY-MM-DD HH:MM" */
  lastFired: string;
}

export type MixerAppSource = "music" | "preview";

export interface MixerInput {
  kind: "app" | "device";
  app: MixerAppSource | "";
  deviceId: string;
}

export interface MixerOutput {
  kind: "bus" | "device";
  /** id del bus o deviceId de la tarjeta; "default" = salida del sistema */
  id: string;
}

export interface MixerChannel {
  id: string;
  name: string;
  color: string;
  input: MixerInput;
  output: MixerOutput;
  gainDb: number;
  muted: boolean;
}

export interface MixerBus {
  id: string;
  name: string;
  color: string;
  outputDeviceId: string;
  gainDb: number;
  muted: boolean;
}

export interface Settings {
  fadeSeconds: number;
  autopilotEnabled: boolean;
  autopilotMinUpcoming: number;
  autopilotFillTo: number;
  repeatTitleMinutes: number;
  repeatArtistMinutes: number;
  repeatTrackMinutes: number;
  avoidConsecutiveArtist: boolean;
  masterVolume: number;
  /** Carpeta de musica predefinida; "" = carpeta interna de la app */
  musicPath: string;
  /** Bloques de los que elige el piloto automatico; [] = toda la biblioteca */
  autoBlocks: string[];
  /** Objetivo de sonoridad de la normalizacion (LUFS) */
  targetLufs: number;
  /** Techo de pico real (dBTP) */
  truePeakDb: number;
  radioName: string;
  slogan: string;
  logoPath: string;
  campaigns: Campaign[];
  events: StationEvent[];
  mixerChannels: MixerChannel[];
  mixerBuses: MixerBus[];
}

export const DEFAULT_SETTINGS: Settings = {
  fadeSeconds: 6,
  autopilotEnabled: false,
  autopilotMinUpcoming: 4,
  autopilotFillTo: 10,
  repeatTitleMinutes: 240,
  repeatArtistMinutes: 120,
  repeatTrackMinutes: 480,
  avoidConsecutiveArtist: true,
  masterVolume: 1,
  musicPath: "",
  autoBlocks: [],
  targetLufs: -9,
  truePeakDb: -1,
  radioName: "MiRadio",
  slogan: "Estudio de automatización",
  logoPath: "",
  campaigns: [],
  events: [],
  mixerChannels: [],
  mixerBuses: [],
};
