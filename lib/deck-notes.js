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

export function mergeDeckNotes(base, incoming) {
  return { ...normalizeDeckNotes(base), ...normalizeDeckNotes(incoming) };
}
