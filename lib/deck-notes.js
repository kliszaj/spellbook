// Per-deck "Game plan" text (a pasted primer or the player's own notes).
export const DECK_NOTES_MAX = 20000;

export function normalizeDeckNotes(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [folderId, text] of Object.entries(value)) {
    if (typeof text === "string" && text.trim()) out[folderId] = text.slice(0, DECK_NOTES_MAX);
  }
  return out;
}

// Server-authoritative: existing (server) keys win; incoming only fills in keys the
// server doesn't have yet (first-device migration onto an empty/partial server copy).
export function mergeDeckNotes(base, incoming) {
  return { ...normalizeDeckNotes(incoming), ...normalizeDeckNotes(base) };
}
