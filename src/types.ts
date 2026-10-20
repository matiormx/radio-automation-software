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
