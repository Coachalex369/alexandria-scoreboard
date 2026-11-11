// Sortable unique ids: <ms timestamp base36>-<counter>-<random>. Browser-safe.
let counter = 0;
export function newId(prefix = "evt") {
  counter = (counter + 1) % 46656;
  const rnd = Math.floor(Math.random() * 46656).toString(36).padStart(3, "0");
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(3, "0")}${rnd}`;
}

// Deterministic id from a source record, so re-ingesting the same file never duplicates events.
export function stableId(prefix, ...parts) {
  let h = 2166136261;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  let h2 = 5381;
  for (let i = s.length - 1; i >= 0; i--) h2 = (Math.imul(h2, 33) ^ s.charCodeAt(i)) >>> 0;
  return `${prefix}_${h.toString(36)}${h2.toString(36)}`;
}
