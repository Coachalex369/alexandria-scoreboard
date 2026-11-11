// Durable local persistence for Stopwatch & ETA v0.2 (Node only). All files live in the data directory
// (default ~/.claude/eta/scoreboard/) and are content-free.
//
//   tasks.jsonl              completed live task records, append-only, one line per task id (fsynced)
//   history.backfill.jsonl   completed task records rebuilt from transcripts by `sb-calibrate backfill` (replaced
//                            atomically; never mixed into tasks.jsonl)
//   checkpoint.json          open tasks' stopwatch totals, rewritten atomically every few seconds by the server
//   calibration.json         the evaluator's latest metrics (`sb-calibrate evaluate`)
//   eval/                    controlled-evaluation records (`sb-eval`)
//
// Recovery: the hook log, marks and transcripts are append-only, so a restarted server replays them and rebuilds
// every open task exactly (the stopwatch is order-independent). The checkpoint covers the one case replay cannot:
// a source log that was truncated or rotated while a task was open. Such a task is written to tasks.jsonl as
// `partial: true` with the totals it had at the last checkpoint, so measured time is never silently lost, and
// partial records are excluded from calibration.
import fs from "node:fs";
import path from "node:path";

export class Ledger {
  constructor(dataDir) {
    this.dir = dataDir; fs.mkdirSync(dataDir, { recursive: true });
    this.tasksFile = path.join(dataDir, "tasks.jsonl");
    this.backfillFile = path.join(dataDir, "history.backfill.jsonl");
    this.checkpointFile = path.join(dataDir, "checkpoint.json");
    this.calibrationFile = path.join(dataDir, "calibration.json");
    this.ids = new Set(readJsonl(this.tasksFile).map((r) => r.id));
  }

  liveRecords() { return readJsonl(this.tasksFile); }
  backfillRecords() { return readJsonl(this.backfillFile); }

  // Calibration history: live records win over backfilled records of the same task; partial records and records
  // with no observed work (calibratable === false) are excluded. allRecords() keeps them for reporting.
  history() { return this.allRecords().filter((r) => r.calibratable !== false); }
  allRecords() {
    const live = this.liveRecords().filter((r) => !r.partial);
    return [...dropOverlapping(this.backfillRecords(), live), ...live].sort((a, b) => (a.endedAt || "").localeCompare(b.endedAt || ""));
  }

  append(rec) {
    if (!rec?.id || this.ids.has(rec.id)) return false;
    this.ids.add(rec.id);
    const fd = fs.openSync(this.tasksFile, "a");
    try { fs.writeSync(fd, JSON.stringify(rec) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return true;
  }

  writeBackfill(records) { writeAtomic(this.backfillFile, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "")); }
  readCheckpoint() { try { return JSON.parse(fs.readFileSync(this.checkpointFile, "utf8")); } catch { return null; } }
  writeCheckpoint(cp) { writeAtomic(this.checkpointFile, JSON.stringify(cp)); }
  readCalibration() { try { return JSON.parse(fs.readFileSync(this.calibrationFile, "utf8")); } catch { return null; } }
  writeCalibration(c) { writeAtomic(this.calibrationFile, JSON.stringify(c, null, 1)); }

  // After a restart and replay: any task the checkpoint saw open that the replay did not rebuild is recorded as
  // partial (its source data is gone). Returns the records written.
  recoverMissing(checkpoint, rebuiltIds) {
    const out = [];
    for (const t of checkpoint?.open || []) {
      if (rebuiltIds.has(t.id) || this.ids.has(t.id)) continue;
      const rec = { ...t.record, partial: true, endReason: "recovered-after-restart", recoveredAt: new Date().toISOString(), checkpointAt: checkpoint.at };
      if (this.append(rec)) out.push(rec);
    }
    return out;
  }
}

// The same work can be recorded twice: live (hook log) and backfilled (transcripts), under different task ids because
// the boundaries come from different sources. A backfilled record is dropped when a live record of the same session
// overlaps it in time, so no work is counted twice in calibration.
export function dropOverlapping(backfill, live) {
  const bySession = new Map(); for (const r of live) (bySession.get(r.session) || bySession.set(r.session, []).get(r.session)).push(r);
  const ids = new Set(live.map((r) => r.id));
  return backfill.filter((b) => !ids.has(b.id) && !(bySession.get(b.session) || []).some((l) => l.startedAt < b.endedAt && b.startedAt < l.endedAt));
}

// Write to a temp file in the same directory, fsync, then rename over the target: readers see old or new, never half.
export function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

export function readJsonl(file) {
  let text; try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = []; for (const l of text.split("\n")) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* torn last line after a crash: skip */ } }
  return out;
}
