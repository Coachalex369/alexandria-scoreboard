// Append-only JSONL event store with an in-memory index. Node only (file system).
// Dedupes on event id so adapters can be re-run over the same source safely.
import fs from "node:fs";
import path from "node:path";
import { assertEvent } from "./schema.js";

export class EventStore {
  constructor(file) {
    this.file = file;
    this.events = [];
    this.byId = new Map();
    if (file && fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        this.events.push(e); this.byId.set(e.id, e);
      }
    }
  }

  // Returns the number of events actually added (duplicates by id are skipped).
  append(events) {
    const fresh = [];
    for (const e of events) {
      assertEvent(e);
      if (this.byId.has(e.id)) continue;
      this.byId.set(e.id, e); this.events.push(e); fresh.push(e);
    }
    if (fresh.length && this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, fresh.map((e) => JSON.stringify(e)).join("\n") + "\n");
    }
    return fresh.length;
  }

  sorted() { return [...this.events].sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id)); }

  sessions() {
    const m = new Map();
    for (const e of this.events) {
      const s = m.get(e.session.id) || { id: e.session.id, project: e.session.project, first: e.ts, last: e.ts, count: 0 };
      if (e.ts < s.first) s.first = e.ts; if (e.ts > s.last) s.last = e.ts; s.count++;
      m.set(e.session.id, s);
    }
    return [...m.values()];
  }

  stats() {
    const byKind = {}, bySource = {}, byActor = {};
    for (const e of this.events) {
      byKind[e.kind] = (byKind[e.kind] || 0) + 1;
      bySource[e.source] = (bySource[e.source] || 0) + 1;
      byActor[e.actor.type] = (byActor[e.actor.type] || 0) + 1;
    }
    return { total: this.events.length, sessions: this.sessions().length, byKind, bySource, byActor };
  }
}
