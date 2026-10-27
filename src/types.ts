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
  /** Punto de intro: donde empieza a cantar (0 = ninguno) */
  introPoint: number;
  /** Punto de mezcla: donde entra la siguiente cancion (0 = ninguno) */
  mixPoint: number;
  /** Punto donde empieza el fade out hacia el final (0 = ninguno) */
  fadeOutStart: number;
  analyzedAt: number;
  /** Se calcula al listar: el registro vive aunque falte el archivo */
  missing: boolean;
  cover: string;
  /** Codigo de idioma de la cancion ("es", "en"…); vacio = sin indicar */
  language?: string;
  /** «Artista del álbum» (agrupa los álbumes) */
  albumArtist?: string;
  /** Extension del archivo en minusculas (flac, mp3…) */
  format?: string;
  /** Calidad del archivo (0 = desconocida) */
  audioRate?: number;
  audioBits?: number;
  audioKbps?: number;
  /** Intro superpuesto que el reproductor mezcla sobre esta pista (lo calcula la app) */
  introOverlay?: IntroOverlay;
}

/** Audio de un bloque de intros que suena sobre el hueco inicio→intro de una pista. */
export interface IntroOverlay {
  file: string;
  durationSecs: number;
  /** Segundo del archivo de la pista donde empieza el intro */
  at: number;
  gainDb: number;
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
  language?: string;
}

/** Configuracion del analisis de metadatos con Ollama local. */
export interface AiSettings {
  /** Direccion del servidor Ollama (por defecto http://127.0.0.1:11434) */
  url: string;
  /** Modelo de Ollama que se usara para clasificar */
  model: string;
}

/** Propuesta de metadatos generada por la IA para una cancion. */
export interface AiSuggestion {
  language: string;
  genre: string;
  tags: string[];
  /** 0 a 1; el modelo puede devolver 0 si no esta seguro */
  confidence: number;
  reason: string;
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
  introPoint: number;
  mixPoint: number;
  fadeOutStart: number;
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
  /** Metadatos por posicion (anuncios/eventos); null = los de la cancion */
  meta?: (StreamMeta | null)[];
}

export interface PlaylistRow {
  id: string;
  /** Es un video */
  video?: boolean;
  title: string;
  artist: string;
  album: string;
  durationSecs: number;
  cover: string;
  /** Bloques musicales a los que pertenece */
  blocks: string[];
  /** Metadatos propios de esta emision (anuncio, evento…), si los hay */
  meta?: StreamMeta | null;
}

export type CampaignKind = "ads" | "jingle";

/** Franja de programacion con sus propios dias y horas. */
export interface ScheduleBlock {
  id: string;
  days: number[];
  times: string[];
  /** Campañas: emitir cada hora al minuto indicado */
  hourly?: boolean;
  minute?: number;
  /** Eventos de internet: hora de inicio y fin */
  start?: string;
  end?: string;
}

export interface Campaign {
  id: string;
  name: string;
  kind: CampaignKind;
  enabled: boolean;
  /** Programacion clasica (equivale a la primera franja) */
  days: number[];
  times: string[];
  hourly: boolean;
  minute: number;
  /** Varias franjas; si falta, se usa days/times/hourly/minute */
  schedules?: ScheduleBlock[];
  /** Metadatos que se usan al emitir cada spot de la campaña */
  meta?: StreamMeta;
  /** Inicio de la campaña (fecha y hora local); "" = sin límite */
  startAt: string;
  /** Fin de la campaña (fecha y hora local); "" = permanente */
  endAt: string;
  trackIds: string[];
  cursor: number;
  lastFired: string;
}

export type StationEventKind = "auto" | "insert" | "stream";

/** Datos que se muestran mientras suena una emision de internet (como una cancion). */
export interface StreamMeta {
  title: string;
  artist: string;
  album: string;
  year: string;
  genre: string;
  comment: string;
  /** Ruta de la portada */
  cover: string;
}
export type StationEventSource = "block" | "library";
/** Al pasar la espera máxima: forzar, cancelar, o «next» = se queda como siguiente sin límite */
export type StationEventTimeout = "force" | "cancel" | "next";

export interface StationEvent {
  id: string;
  name: string;
  enabled: boolean;
  kind: StationEventKind;
  days: number[];
  /** Hora de inicio de la franja (auto) o de la inserción (insert), HH:MM */
  start: string;
  /** Horas adicionales para eventos sin fin (auto/insert); vacío = usar start */
  times?: string[];
  /** Varias franjas con sus propios días y horas; si falta, se usa days/start/times */
  schedules?: ScheduleBlock[];
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
  /** stream: hora de fin HH:MM (si es menor que el inicio, termina al día siguiente) */
  end?: string;
  /** stream: dirección del audio (Icecast, HLS .m3u8, MP3/AAC por HTTP…) o un archivo */
  streamUrl?: string;
  /** stream: fundido de entrada y salida (s) */
  fadeSecs?: number;
  /** stream: datos que se muestran mientras suena */
  meta?: StreamMeta;
  /** insert: "fixed" = una pista concreta; "random" = una al azar de sourceKind/sourceId */
  trackMode?: "fixed" | "random";
  /** random: no repetir la misma pista a la misma hora durante tantos días (0 = sin regla) */
  noRepeatSlotDays?: number;
  /** random: no repetir la misma pista en este evento (a cualquier hora) durante tantos días */
  noRepeatEventDays?: number;
  /** random: no elegir pistas que hayan sonado en antena hace menos de tantos minutos */
  noRepeatAirMins?: number;
  /** random: pistas elegidas (para las reglas de repetición) */
  pickLog?: PickEntry[];
}

/** Una pista elegida al azar por un evento. */
export interface PickEntry {
  /** Horario HH:MM que la lanzó */
  slot: string;
  trackId: string;
  /** Milisegundos desde epoch */
  at: number;
}

export type MixerAppSource = "music" | "preview" | "call";

export interface MixerInput {
  kind: "app" | "device";
  app: MixerAppSource | "";
  deviceId: string;
  /** Estéreo: par de canales de la tarjeta (1 = 1-2, 2 = 3-4…). Mono: canal (0 = mezcla L+R) */
  channel?: number;
}

export interface MixerOutput {
  kind: "bus" | "device";
  /** id del bus o deviceId de la tarjeta; "default" = salida del sistema */
  id: string;
}

/** Nivelador automatico de ganancia de un canal o bus (ver leveler.ts). */
/** Plugin VST3 en un canal o bus (motor nativo). */
export interface PluginSlot {
  id: string;
  /** Ruta del .vst3 */
  path: string;
  name: string;
  /** false = bypass (cargado, sin procesar) */
  enabled: boolean;
  /** Desactivado: ni se carga ni gasta CPU */
  off?: boolean;
}

export interface CompressorSettings {
  enabled: boolean;
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
}

export interface LevelerSettings {
  enabled: boolean;
  /** Sonoridad objetivo en LUFS */
  targetLufs: number;
  /** Maximo de subida o bajada en dB */
  maxGainDb: number;
}

/**
 * Insert de un canal o bus: la senal sale por una tarjeta (send), pasa por un
 * procesador externo (plugin host, SuperRack...) y vuelve por una entrada (return).
 */
export interface InsertSettings {
  enabled: boolean;
  sendDeviceId: string;
  returnDeviceId: string;
}

/**
 * Entrada o salida de audio habilitada en Ajustes > Sonido. Solo estas
 * aparecen en la mesa, con su alias si se les ha puesto uno.
 */
export interface AudioDeviceSetting {
  id: string;
  kind: "audioinput" | "audiooutput";
  /** Nombre que da el sistema a la tarjeta */
  label: string;
  /** Alias visible en la mesa; vacio = usar label */
  name: string;
  enabled: boolean;
}

/** Envio de un canal a un bus (ademas de su salida principal). */
/** API compatible con RadioBOSS (las claves van aparte, en secretos). */
export interface ApiSettings {
  enabled: boolean;
  port: number;
  /** Escuchar en toda la red (si no, solo en este equipo, para el tunel) */
  bindAll: boolean;
  /** status-json.xsl de Icecast; vacio = el de la primera emision Icecast */
  icecastStatusUrl: string;
  /** Aviso de cambio de cancion (p. ej. https://core.ngradio.es/update) */
  updateUrl: string;
}

export interface MixerSend {
  busId: string;
  gainDb: number;
  /** Antes del fader (no le afecta el volumen del canal) */
  pre: boolean;
  muted: boolean;
}

export type MixerAgc = "off" | "slow" | "fast";

export interface MixerChannel {
  id: string;
  name: string;
  color: string;
  input: MixerInput;
  output: MixerOutput;
  /** Ganancia de entrada, antes de inserts y del fader */
  inputGainDb?: number;
  /** Control automatico de ganancia; si no esta en "off", ignora inputGainDb */
  agc?: MixerAgc;
  gainDb: number;
  muted: boolean;
  leveler?: LevelerSettings;
  compressor?: CompressorSettings;
  plugins?: PluginSlot[];
  /** En el grupo que se sincroniza (compensación de latencia de plugins) */
  sync?: boolean;
  insert?: InsertSettings;
  /** Panorama/balance: -1 izquierda, 0 centro, 1 derecha */
  pan?: number;
  solo?: boolean;
  /** Estereo (off), suma L+R, solo izquierda o solo derecha; sale igual por los dos lados */
  monoMode?: "off" | "sum" | "left" | "right";
  sends?: MixerSend[];
}

export interface MixerBus {
  id: string;
  name: string;
  color: string;
  outputDeviceId: string;
  gainDb: number;
  muted: boolean;
  leveler?: LevelerSettings;
  compressor?: CompressorSettings;
  plugins?: PluginSlot[];
  insert?: InsertSettings;
  pan?: number;
  sends?: MixerSend[];
}

export type VideoInputKind = "file" | "rtmp" | "ndi" | "capture";
export type VideoOutputKind = "screen" | "decklink" | "ndi" | "rtmp";

export interface VideoInput {
  id: string;
  name: string;
  kind: VideoInputKind;
  /** Ruta de archivo, URL RTMP, nombre NDI o dispositivo de captura */
  source: string;
  /** Identificador del navegador para la vista previa de una capturadora */
  deviceId?: string;
  enabled: boolean;
}

/** Capturadora o dispositivo de audio de captura detectado en el equipo. */
export interface VideoCaptureDevice {
  /** Valor que se pasa a FFmpeg */
  id: string;
  name: string;
  kind?: "video" | "audio";
  /** deviceId de WebView para mostrar la captura en pantalla */
  deviceId?: string;
}

/** Audio que acompaña a una salida de vídeo: la mesa, el de la propia entrada (NDI/capturadora) o un dispositivo. */
export type VideoAudioSource = "mixer" | "input" | "device";

export interface VideoOutput {
  id: string;
  name: string;
  kind: VideoOutputKind;
  /** Monitor, dispositivo DeckLink, nombre NDI o URL RTMP */
  source: string;
  /** Entrada de vídeo a emitir: "program" = pantalla de emisión, "nowplaying" = lo que suena, o el id de una entrada */
  videoInputId?: string;
  /** Respaldo si falla el vídeo principal: "" = ninguno, "program" = pantalla de emisión, "nowplaying" = lo que suena */
  fallbackVideoInputId?: string;
  /** "mixer" = salida Encoders de la mesa; "device" = audio de capturadora */
  audioSource?: VideoAudioSource;
  /** Dispositivo de audio de captura cuando audioSource = "device" */
  audioSourceId?: string;
  enabled: boolean;
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
}

export interface VideoSettings {
  enabled: boolean;
  inputs: VideoInput[];
  outputs: VideoOutput[];
  /** FFmpeg compilado con NDI; vacío = usar el FFmpeg normal */
  ndiFfmpegPath?: string;
  /** Tope de altura de todo el vídeo (720 = 1280×720); 0 = sin tope */
  maxHeight?: number;
  /** Recibir NDI en calidad ligera (proxy): mucha menos red */
  ndiLowBandwidth?: boolean;
  /** Compresión del vídeo emitido: auto | nvenc | qsv | amf | x264 */
  encoder?: string;
}

/** Ventana de video de la emision (los videos de la lista, en pantalla). */
export interface VideoScreenSettings {
  enabled: boolean;
  /** Monitor (indice en la lista del sistema) */
  monitor: number;
  /** Con canciones de audio: portada y titulo, logo o negro */
  audioMode: "cover" | "logo" | "black";
  /** "program" = lo que suena; "capture" = la capturadora elegida */
  source?: "program" | "capture";
  /** Entrada de captura que se ve en la pantalla y se emite por las salidas */
  captureInputId?: string;
  /** Espejo horizontal solo en la ventana de los locutores */
  mirror?: boolean;
  /** Si la capturadora no tiene señal: "program" (lo que suena, por defecto) o "none" (negro) */
  captureFallback?: "program" | "none";
  /** Encierra el ratón en el monitor de OmniCaster (Ctrl+Mayús lo libera) */
  cursorWall?: boolean;
}

export type IcecastCodec = "flac" | "aac";

export interface IcecastStream {
  id: string;
  name: string;
  enabled: boolean;
  host: string;
  port: number;
  mount: string;
  username: string;
  password: string;
  tls: boolean;
  codec: IcecastCodec;
  bitrateKbps: number;
  sampleRate: number;
  channels: 1 | 2;
  public: boolean;
  stationName: string;
  description: string;
  genre: string;
}

export interface RtmpOutput {
  enabled: boolean;
  url: string;
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  keyframeSecs: number;
  /** Entrada de vídeo a emitir; "" = la de la pantalla externa */
  videoInputId?: string;
  /** "mixer" = salida Encoders de la mesa; "device" = audio de capturadora */
  audioSource?: VideoAudioSource;
  audioSourceId?: string;
}

export interface StreamingSettings {
  icecast: IcecastStream[];
  rtmp: RtmpOutput;
  /** Empezar a emitir al abrir OmniCaster */
  autoStart?: boolean;
}

export interface StreamOutputStatus {
  id: string;
  name: string;
  kind: string;
  running: boolean;
  /** "reconnecting": se cayó y OmniCaster la está volviendo a arrancar (o pasando al respaldo) */
  state: "live" | "stopped" | "error" | "reconnecting";
  error: string | null;
  /** Últimas líneas de FFmpeg para diagnosticar la salida */
  log?: string | null;
  /** Rendimiento en directo: fps, velocidad, imágenes duplicadas/perdidas */
  stats?: string | null;
}

export interface StreamStatus {
  /** La emisión (Icecast o RTMP) está en marcha */
  running: boolean;
  /** Alguna salida del estudio (pantalla/HDMI, NDI, SDI) está en marcha */
  localRunning?: boolean;
  needsAudio: boolean;
  ffmpeg: string | null;
  outputs: StreamOutputStatus[];
  lastError: string | null;
}

export interface AppUpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  notes: string;
}

export interface StreamProbe {
  available: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
}

export interface NdiProbe {
  available: boolean;
  ffmpeg: string | null;
  device: string | null;
  runtime: boolean;
  sources: string[];
  error: string | null;
}

/** Canción ya emitida. */
export interface HistoryEntry {
  trackId: string;
  /** Segundos desde epoch */
  playedAt: number;
}

/** Estado de la última sesión, para continuar donde se quedó. */
export interface SessionState {
  playlistId: string;
  trackId: string;
  positionSecs: number;
  playing: boolean;
  updatedAt: number;
}

/** Programa de emisión preparado de antemano. */
export interface Program {
  id: string;
  name: string;
  /** Artista / bajada: va como "artista" en los metadatos */
  subtitle: string;
  /** Metadatos como los de una canción */
  album?: string;
  year?: string;
  genre?: string;
  /** Ruta de la imagen de portada */
  cover: string;
  /** Hora de inicio prevista ("22:00"); vacio = sin hora */
  startsAt: string;
  enabled: boolean;
}

/** Llamadas de oyentes al aire, recogidas del worker de NGRADIO. */
export interface StudioCallsSettings {
  enabled: boolean;
  /** Direccion de la app, por ejemplo https://app.ngradio.es */
  serverUrl: string;
  /** Secreto STUDIO_TOKEN del worker */
  token: string;
}

/** Chat de NGRADIO en OmniCaster (usa la direccion y el token de Llamadas). */
export interface ChatSettings {
  enabled: boolean;
  /** Nombre con el que escribe la emisora */
  name: string;
  /** En su propia ventana en lugar de acoplado */
  floating: boolean;
  /** Acoplado y minimizado */
  collapsed: boolean;
}

export interface NotificationRule {
  id: string;
  name: string;
  enabled: boolean;
  url: string;
  method: "GET" | "POST";
  body: string;
  bodyFormat: "form" | "json" | "text";
  /** "track" | "server" | "silence" | "error" */
  events: string[];
  /** Texto del cambio de cancion: CURRENTSONG o LIVE */
  titleSource: "currentsong" | "live";
}

export interface IntroSettings {
  enabled: boolean;
  /** Bloque con los audios de intro */
  blockId: string;
  /** Donde cae el audio dentro del hueco inicio→intro */
  align: "start" | "end";
  /** Canciones de espera antes de volver a poner un intro */
  gapSongs: number;
  gainDb: number;
}

/** Linux (quiosco): control remoto por VNC */
export interface RemoteSettings {
  vnc: boolean;
  /** Solo por la red de WireGuard */
  vncOnlyWg: boolean;
}

export interface Settings {
  remote?: RemoteSettings;
  fadeSeconds: number;
  /** Margen de las tarjetas de sonido (ms); más = menos cortes, más retardo */
  audioBufferMs?: number;
  /** Reproducir la lista automaticamente al abrir la app */
  autoPlayOnStart: boolean;
  /** Pasar a la siguiente pista (o reanudar) si hay silencio */
  silenceDetection: boolean;
  /** Umbral de silencio en dBFS (RMS); por debajo se considera silencio */
  silenceThresholdDb: number;
  /** Canciones ya emitidas que siguen visibles (opacas) en la lista */
  pastVisible: number;
  /** Idiomas habilitados para las canciones (codigos) */
  languages: string[];
  /** Probabilidad (%) de que el AutoDJ elija cada idioma; sin datos = sin filtro */
  languageWeights: Record<string, number>;
  /** Avisos GET/POST ante eventos */
  notifications: NotificationRule[];
  intros: IntroSettings;
  /** El VU de la pantalla principal mide la salida general o la de streaming */
  vuSource: "master" | "streaming";
  videoScreen: VideoScreenSettings;
  /** Plugins VST3: carpetas extra y plugins ocultos en el selector */
  vst?: { extraFolders: string[]; hidden: string[] };
  /** Ancho del panel de musica (px); 0 = automatico */
  leftPanelWidth: number;
  chat: ChatSettings;
  /** Motor de audio: "web" (WebView2) o "native" (Rust, beta) */
  audioEngine: "web" | "native";
  /** API compatible con RadioBOSS para ngradio.es */
  api: ApiSettings;
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
  /** Bloque por defecto del AutoDJ; "" = usar autoBlocks o toda la biblioteca */
  defaultBlockId: string;
  /** Modo LIVE: la barra auxiliar sustituye los metadatos por los del programa */
  liveMode: boolean;
  /** Programa seleccionado en modo LIVE */
  liveProgramId: string;
  /** Programas preparados de antemano */
  programs: Program[];
  /** Archivo "now playing" que se escribe con la cancion que suena */
  nowPlayingPath: string;
  /** Plantilla del archivo nowplaying; por defecto "{artist} - {title}" */
  nowPlayingTemplate: string;
  /** Archivo "live" con el programa; "" = en la carpeta del nowplaying */
  liveFilePath: string;
  /** Plantilla del archivo live; por defecto "{artist} - {title}" */
  liveTemplate: string;
  /** Objetivo de sonoridad de la normalizacion (LUFS) */
  targetLufs: number;
  /** Techo de pico real (dBTP) */
  truePeakDb: number;
  radioName: string;
  slogan: string;
  logoPath: string;
  campaigns: Campaign[];
  events: StationEvent[];
  /** Interruptor general: si está apagado, no se lanza ningún evento */
  eventsEnabled: boolean;
  mixerChannels: MixerChannel[];
  mixerBuses: MixerBus[];
  /** Entradas y salidas habilitadas para la mesa */
  audioDevices: AudioDeviceSetting[];
  /** Analisis de metadatos con Ollama local */
  ai: AiSettings;
  /** Bus cuya señal muestra el VU de salida; "" = salida general */
  monitorBusId: string;
  /** Tarjeta de salida del Master; "" = salida predeterminada del sistema */
  masterOutputDeviceId: string;
  /** Tarjeta de salida de monitorizacion/preescucha; "" = predeterminada */
  monitorOutputDeviceId: string;
  video: VideoSettings;
  streaming: StreamingSettings;
  studioCalls: StudioCallsSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  fadeSeconds: 6,
  audioBufferMs: 40,
  autoPlayOnStart: false,
  silenceDetection: false,
  silenceThresholdDb: -55,
  pastVisible: 5,
  languages: ["es", "en", "pt", "de", "fr"],
  languageWeights: {},
  notifications: [],
  intros: { enabled: false, blockId: "", align: "end", gapSongs: 3, gainDb: 0 },
  vuSource: "master",
  videoScreen: { enabled: false, monitor: 1, audioMode: "cover", source: "program", captureInputId: "", mirror: false },
  leftPanelWidth: 0,
  chat: { enabled: false, name: "", floating: false, collapsed: false },
  audioEngine: "web",
  api: { enabled: false, port: 9000, bindAll: false, icecastStatusUrl: "", updateUrl: "" },
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
  defaultBlockId: "",
  liveMode: false,
  liveProgramId: "",
  programs: [],
  nowPlayingPath: "",
  nowPlayingTemplate: "{artist} - {title}",
  liveFilePath: "",
  liveTemplate: "{artist} - {title}",
  targetLufs: -9,
  truePeakDb: -1,
  radioName: "",
  slogan: "Estudio de automatización",
  logoPath: "",
  campaigns: [],
  events: [],
  eventsEnabled: true,
  mixerChannels: [],
  mixerBuses: [],
  audioDevices: [],
  ai: { url: "http://127.0.0.1:11434", model: "llama3.1:8b" },
  monitorBusId: "",
  masterOutputDeviceId: "",
  monitorOutputDeviceId: "",
  video: {
    enabled: false,
    inputs: [],
    outputs: [],
    ndiFfmpegPath: "",
    maxHeight: 720,
    ndiLowBandwidth: false,
    encoder: "auto",
  },
  streaming: {
    icecast: [],
    rtmp: {
      enabled: false,
      url: "",
      width: 1920,
      height: 1080,
      fps: 25,
      bitrateKbps: 6000,
      keyframeSecs: 2,
      videoInputId: "",
      audioSource: "mixer",
      audioSourceId: "",
    },
  },
  studioCalls: { enabled: false, serverUrl: "", token: "" },
};

export interface DeezerTrack {
  id: number;
  title: string;
  artist: string;
  album: string;
  durationSecs: number;
  preview: string;
  cover: string;
  coverBig?: string;
  year: string;
  genre: string;
}

/** Nivel de un canal del vumetro: 0..1 y dBFS. */
export interface VULevel {
  level: number;
  db: number;
}

/** Nivel estereo del vumetro, con el maximo en `level`/`db`. */
export interface VUStereoLevel extends VULevel {
  left: VULevel;
  right: VULevel;
}

/** Franjas de una campaña (o la programación clásica si no tiene). */
export function campaignSchedules(campaign: Campaign): ScheduleBlock[] {
  if ((campaign.schedules?.length ?? 0) > 0) return campaign.schedules!;
  return [
    {
      id: `${campaign.id}-legacy`,
      days: campaign.days,
      times: campaign.times,
      hourly: campaign.hourly,
      minute: campaign.minute,
    },
  ];
}

/** Franjas de un evento (o la programación clásica si no tiene). */
export function eventSchedules(event: StationEvent): ScheduleBlock[] {
  if ((event.schedules?.length ?? 0) > 0) return event.schedules!;
  const times = (event.times ?? []).filter(Boolean);
  return [
    {
      id: `${event.id}-legacy`,
      days: event.days,
      times: times.length > 0 ? times : [event.start],
      start: event.start,
      end: event.end ?? "",
    },
  ];
}
