// STEPS LEFT pulse (pure). Design decision 2026-11-13: while STEPS LEFT shows a number it pulses twice (two quick
// dim-bright cycles, about 1 s in total), stays steadily lit for 30 s, and repeats. Dark: no pulsing. Reduced motion:
// steady, no pulses.
export const PULSE = { count: 2, pulseMs: 500, steadyMs: 30e3 };
export const PULSE_CYCLE_MS = PULSE.count * PULSE.pulseMs + PULSE.steadyMs;

// msSinceLit: time since the number appeared. Returns "dim" or "bright".
export function stepsLeftPulse(msSinceLit, { reduced = false, lit = true } = {}) {
  if (!lit || reduced || !(msSinceLit >= 0)) return "bright";
  const t = msSinceLit % PULSE_CYCLE_MS;
  if (t >= PULSE.count * PULSE.pulseMs) return "bright";
  return t % PULSE.pulseMs < PULSE.pulseMs / 2 ? "dim" : "bright";
}
