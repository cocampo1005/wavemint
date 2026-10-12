// Editable metadata fields, shared by the single, bulk and album editors.

export const EDIT_FIELDS = [
  { key: "title", column: "title", label: "Title", wide: true },
  { key: "artist", column: "artist", label: "Artist" },
  { key: "albumArtist", column: "album_artist", label: "Album artist" },
  { key: "album", column: "album", label: "Album", wide: true },
  { key: "genre", column: "genre", label: "Genre" },
  { key: "year", column: "year", label: "Year", type: "number" },
  { key: "trackNo", column: "track_no", label: "Track", type: "number" },
  { key: "trackTotal", column: "track_total", label: "of", type: "number" },
  { key: "discNo", column: "disc_no", label: "Disc", type: "number" },
  { key: "discTotal", column: "disc_total", label: "of", type: "number" },
  { key: "composer", column: "composer", label: "Composer", wide: true },
  { key: "comment", column: "comment", label: "Comment", wide: true },
  { key: "compilation", column: "compilation", label: "Part of a compilation", type: "bool", wide: true },
];

export const FIELD_LABELS = Object.fromEntries([
  ...EDIT_FIELDS.map((field) => [field.key, field.label === "of" ? `${field.key.startsWith("track") ? "Track" : "Disc"} total` : field.label]),
  ...EDIT_FIELDS.map((field) => [field.column, field.label === "of" ? `${field.key.startsWith("track") ? "Track" : "Disc"} total` : field.label]),
  ["artwork", "Artwork"],
  ["artwork_hash", "Artwork"],
  ["rating", "Rating"],
  ["notes", "Notes"],
]);

/** Form value (string/bool) -> API value. */
export function toApiValue(field, value) {
  if (field.type === "number") {
    const number = Number(String(value).trim());
    return String(value).trim() === "" || !Number.isFinite(number) ? 0 : Math.round(number);
  }
  if (field.type === "bool") return !!value;
  return String(value ?? "");
}

/** Track row value -> form value. */
export function toFormValue(field, value) {
  if (field.type === "bool") return !!value;
  if (field.type === "number") return value ? String(value) : "";
  return value ?? "";
}

export function displayValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (typeof value === "string" && /^[a-f0-9]{40}$/.test(value)) return "Custom image";
  return String(value);
}
