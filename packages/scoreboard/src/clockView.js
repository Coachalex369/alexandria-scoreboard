// GAME CLOCK display (pure, browser-safe). Design decision 2026-11-13: the digits show time LEFT only, as M:SS under
// an hour and H:MM (HRS lamp) from an hour; they never show a "+", a unit letter or a negative time, and they never
// blink in any state: the lamps carry the state (OVERTIME, EST, HRS, RUNNING, TIMEOUT).
import { fitClock } from "./digits.js";

export function gameClockView(g) {
  const lamps = { overtime: false, est: false, hrs: false };
  if (g?.mode === "countdown") {
    const c = fitClock(Math.ceil(Math.max(0, g.remainingMs || 0) / 1000) * 1000);
    lamps.overtime = (g.overtime || 0) > 0; lamps.est = !!g.estimate; lamps.hrs = c.hours;
    return { text: c.text, dim: false, flash: false, lamps };
  }
  if (g?.mode === "final") return { text: fitClock(0).text, dim: true, flash: false, lamps };
  return { text: "--:--", dim: true, flash: false, lamps };
}

// A remaining-time range in whole minutes for the note under the clock; under a minute it says so (never "0-0 MIN").
const mins = (ms) => String(Math.max(0, Math.round((ms || 0) / 60000)));
export function rangeWords(r) { const hi = r?.hiMs ?? 0, lo = r?.loMs ?? 0; return hi < 60e3 ? "UNDER 1 MIN" : `${mins(lo)}–${mins(hi)} MIN`; }
