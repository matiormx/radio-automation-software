export interface Track {
  id: string;
  title: string;
  artist: string;
  durationSecs: number;
  fileName: string;
  originalName: string;
  filePath: string;
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
};
