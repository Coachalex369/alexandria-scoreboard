// Demo recordings replay through the same Replayer the browser uses: events must arrive in causal order, the
// declared estimate must attach, the GAME CLOCK must count down for most of the run and STEPS LEFT must show a number.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Replayer } from "../../event-engine/src/replay.js";
import { Board } from "../src/board.js";

for (const name of ["synthetic-multi-agent", "forge-demo-session"]) {
  test(`demo ${name}: replayed like the browser, the estimate attaches and the GAME CLOCK counts down`, () => {
    const raw = fs.readFileSync(new URL(`../../../demo/recordings/${name}.events.jsonl`, import.meta.url), "utf8");
    const events = raw.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    for (const e of events) e.provenance = { ...(e.provenance || {}), synthetic: true };
    const ordered = new Replayer(events).events; // the browser's playback order
    const b = new Board({ recordHistory: false });
    const sid = ordered[0].session.id, t0 = Date.parse(ordered[0].ts), t1 = Date.parse(ordered.at(-1).ts);
    let i = 0, samples = 0, counting = 0, stepsLeft = 0, estimateSeen = false;
    for (let t = t0; t <= t1; t += 5000) {
      while (i < ordered.length && Date.parse(ordered[i].ts) <= t) b.apply(ordered[i++]);
      const s = b.snapshot(sid, t); samples++;
      if (s.task?.estimate) estimateSeen = true;
      if (s.game.mode === "countdown") counting++;
      if (s.guest.basis !== "unavailable") stepsLeft++;
    }
    assert.ok(estimateSeen, "the declared estimate attaches to the task");
    assert.ok(counting / samples > 0.8, `GAME CLOCK counts down for most of the replay (${counting}/${samples})`);
    assert.ok(stepsLeft / samples > 0.5, `STEPS LEFT shows a number for most of the replay (${stepsLeft}/${samples})`);
  });
}
