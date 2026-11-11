// Scoreboard alert sounds: synthesized gym horn, referee whistle and buzzer. Browser only (Web Audio).
// Independent of any other sound source: its own AudioContext, mute and volume (persisted in localStorage).
// Original synthesized sounds, no samples (synthesised at run time).
const KEY = "alexandria.scoreboard.alerts";

export class HornKit {
  constructor() {
    this.ctx = null; this.master = null;
    let saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch {}
    this.muted = saved.muted ?? false; this.volume = saved.volume ?? 0.6;
  }
  get enabled() { return !!this.ctx; }
  // Must be called from a user gesture (browser autoplay policy).
  enable() {
    if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return true; }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext; if (!AC) return false;
    this.ctx = new AC(); this.master = this.ctx.createGain(); this.master.gain.value = this.muted ? 0 : this.volume; this.master.connect(this.ctx.destination);
    return true;
  }
  save() { try { localStorage.setItem(KEY, JSON.stringify({ muted: this.muted, volume: this.volume })); } catch {} }
  setMuted(m) { this.muted = !!m; if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.02); this.save(); }
  setVolume(v) { this.volume = Math.max(0, Math.min(1, Number(v) || 0)); if (this.master && !this.muted) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02); this.save(); }

  play(kind) {
    if (!this.ctx || this.muted) return false;
    if (kind === "horn") this.horn(); else if (kind === "whistle") this.whistle(); else if (kind === "buzzer") this.buzzer(); else return false;
    return true;
  }

  // Gym horn: two detuned saws through a low-pass, slow attack, ~1.3 s.
  horn() {
    const c = this.ctx, t = c.currentTime, dur = 1.3;
    const out = c.createGain(); out.gain.setValueAtTime(0.0001, t); out.gain.exponentialRampToValueAtTime(0.7, t + 0.06); out.gain.setValueAtTime(0.7, t + dur - 0.2); out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1100; lp.Q.value = 2;
    for (const [f, type] of [[185, "sawtooth"], [233, "sawtooth"], [92.5, "square"]]) { const o = c.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = (Math.random() - 0.5) * 12; o.connect(lp); o.start(t); o.stop(t + dur + 0.05); }
    lp.connect(out); out.connect(this.master);
  }

  // Referee pea whistle: bright triangle with a fast warble and a breath-noise burst, ~0.8 s.
  whistle() {
    const c = this.ctx, t = c.currentTime, dur = 0.8;
    const out = c.createGain(); out.gain.setValueAtTime(0.0001, t); out.gain.exponentialRampToValueAtTime(0.5, t + 0.02); out.gain.setValueAtTime(0.5, t + dur - 0.15); out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const o = c.createOscillator(); o.type = "triangle"; o.frequency.value = 2650;
    const warble = c.createOscillator(); warble.frequency.value = 27; const wg = c.createGain(); wg.gain.value = 140; warble.connect(wg); wg.connect(o.frequency);
    const o2 = c.createOscillator(); o2.type = "sine"; o2.frequency.value = 2650 * 1.5; const g2 = c.createGain(); g2.gain.value = 0.25; o2.connect(g2); g2.connect(out);
    const noise = c.createBufferSource(); const buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate); const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.08; noise.buffer = buf;
    const bp = c.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 3000; bp.Q.value = 6; noise.connect(bp); bp.connect(out);
    o.connect(out); out.connect(this.master);
    o.start(t); o2.start(t); warble.start(t); noise.start(t); o.stop(t + dur); o2.stop(t + dur); warble.stop(t + dur); noise.stop(t + dur);
  }

  // Buzzer: harsh square pair, ~0.6 s.
  buzzer() {
    const c = this.ctx, t = c.currentTime, dur = 0.6;
    const out = c.createGain(); out.gain.setValueAtTime(0.0001, t); out.gain.exponentialRampToValueAtTime(0.45, t + 0.01); out.gain.setValueAtTime(0.45, t + dur - 0.08); out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1600;
    for (const f of [118, 121.5]) { const o = c.createOscillator(); o.type = "square"; o.frequency.value = f; o.connect(lp); o.start(t); o.stop(t + dur + 0.05); }
    lp.connect(out); out.connect(this.master);
  }
}
