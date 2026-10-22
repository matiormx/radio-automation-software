/** Idiomas de las canciones: codigo ISO 639 → nombre y bandera del pais. */
export interface LanguageInfo {
  code: string;
  name: string;
  flag: string;
}

export const LANGUAGE_CATALOG: LanguageInfo[] = [
  { code: "es", name: "Español", flag: "🇪🇸" },
  { code: "en", name: "Inglés", flag: "🇬🇧" },
  { code: "pt", name: "Portugués", flag: "🇵🇹" },
  { code: "de", name: "Alemán", flag: "🇩🇪" },
  { code: "fr", name: "Francés", flag: "🇫🇷" },
  { code: "it", name: "Italiano", flag: "🇮🇹" },
  { code: "ca", name: "Catalán", flag: "🇦🇩" },
  { code: "gl", name: "Gallego", flag: "🇪🇸" },
  { code: "eu", name: "Euskera", flag: "🇪🇸" },
  { code: "nl", name: "Neerlandés", flag: "🇳🇱" },
  { code: "sv", name: "Sueco", flag: "🇸🇪" },
  { code: "no", name: "Noruego", flag: "🇳🇴" },
  { code: "da", name: "Danés", flag: "🇩🇰" },
  { code: "fi", name: "Finés", flag: "🇫🇮" },
  { code: "pl", name: "Polaco", flag: "🇵🇱" },
  { code: "ru", name: "Ruso", flag: "🇷🇺" },
  { code: "uk", name: "Ucraniano", flag: "🇺🇦" },
  { code: "el", name: "Griego", flag: "🇬🇷" },
  { code: "tr", name: "Turco", flag: "🇹🇷" },
  { code: "ro", name: "Rumano", flag: "🇷🇴" },
  { code: "ja", name: "Japonés", flag: "🇯🇵" },
  { code: "ko", name: "Coreano", flag: "🇰🇷" },
  { code: "zh", name: "Chino", flag: "🇨🇳" },
  { code: "ar", name: "Árabe", flag: "🇸🇦" },
  { code: "he", name: "Hebreo", flag: "🇮🇱" },
  { code: "hi", name: "Hindi", flag: "🇮🇳" },
  { code: "la", name: "Latín", flag: "🇻🇦" },
];

export const DEFAULT_LANGUAGES = ["es", "en", "pt", "de", "fr"];

export function languageInfo(code: string): LanguageInfo | null {
  return LANGUAGE_CATALOG.find((l) => l.code === code) ?? null;
}

export function languageFlag(code: string): string {
  return languageInfo(code)?.flag ?? (code ? "🏳️" : "");
}

export function languageName(code: string): string {
  return languageInfo(code)?.name ?? code.toUpperCase();
}
