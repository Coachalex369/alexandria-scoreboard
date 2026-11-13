// Alert policy (pure). Decides which raised board alerts become a visible banner and which also sound.
// Functional alerts are independent of any other sound source: the horn/whistle synth lives in horn.js and has
// its own mute and volume. Visual alerts are never suppressed by audio settings.
//   permission   → whistle (owner attention)        test-failure → buzzer
//   completed    → horn (main task only)            termination  → buzzer unless the end was a normal exit
//   turn         → quiet (log + brief banner)       anything else → visible only
//   task-ended   → visible only, never the horn (a marked task that ended without completing)
export const SOUND_FOR = { permission: "whistle", "test-failure": "buzzer", completed: "horn", termination: "buzzer" };
export const LEVEL = { "task-ended": "attention", permission: "attention", "test-failure": "danger", termination: "danger", completed: "success", turn: "info", blocked: "attention", "rate-limit": "attention", "api-error": "danger" }; // v0.2 kinds: banner only, no new sounds

export class AlertPolicy {
  constructor({ repeatMs = 10e3, minSoundGapMs = 2500, maxVisible = 6 } = {}) { this.repeatMs = repeatMs; this.minSoundGapMs = minSoundGapMs; this.maxVisible = maxVisible; this.lastByKey = new Map(); this.lastSoundAt = -Infinity; }

  // alerts: board.takeAlerts(); nowMs: wall clock for repeat suppression. Returns { visible: [], sounds: [] }.
  decide(alerts, nowMs) {
    const visible = [], sounds = [];
    for (const a of alerts) {
      const key = `${a.session}|${a.kind}|${a.text}`;
      const last = this.lastByKey.get(key);
      if (last != null && nowMs - last < this.repeatMs) continue; // the same alert again within the window: suppress
      this.lastByKey.set(key, nowMs);
      visible.push({ ...a, level: LEVEL[a.kind] || "info" });
      const sound = SOUND_FOR[a.kind];
      if (sound && !a.quiet && nowMs - this.lastSoundAt >= this.minSoundGapMs) { sounds.push(sound); this.lastSoundAt = nowMs; }
    }
    return { visible: visible.slice(-this.maxVisible), sounds };
  }
}
