// Dot-matrix (5×7) bulb font and a DOM renderer for the scoreboard displays. The font table is pure (tested);
// the renderer builds each display's bulbs once and toggles classes, so a 1 Hz refresh costs almost nothing.
export const COLS = 5, ROWS = 7;
export const FONT = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "/": ["00001", "00010", "00100", "00100", "00100", "01000", "10000"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
  "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  "·": ["00000", "00000", "00000", "00100", "00000", "00000", "00000"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11100", "10010", "10001", "10001", "10001", "10010", "11100"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "10001", "11001", "10101", "10011", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

export function glyph(ch) { return FONT[ch] || FONT[String(ch).toUpperCase()] || FONT["?"]; }

// Fits a value into `width` characters: numbers right-aligned and capped at the display's maximum, null → dashes.
export function fitNumber(value, width, { dashes = true } = {}) {
  if (value == null || !Number.isFinite(value)) return dashes ? "-".repeat(width) : " ".repeat(width);
  const max = 10 ** width - 1; const v = Math.max(0, Math.min(max, Math.round(value)));
  return String(v).padStart(width, " ");
}

// mm:ss under an hour, h:mm from an hour on (callers light an HRS lamp), "--:--" when unavailable.
export function fitClock(ms) {
  if (ms == null || !Number.isFinite(ms)) return { text: "--:--", hours: false };
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 3600) return { text: `${String(Math.floor(s / 60)).padStart(2, " ")}:${String(s % 60).padStart(2, "0")}`, hours: false };
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return { text: `${String(Math.min(99, h)).padStart(2, " ")}:${String(m).padStart(2, "0")}`, hours: true };
}

export function fitText(text, width) { const t = String(text ?? "").toUpperCase().slice(0, width); return t.padEnd(width, " "); }

// DOM renderer. el gets `width` characters of 5×7 bulbs; render(text) toggles the `on` class.
export class MatrixDisplay {
  constructor(el, width, { colour = "red" } = {}) {
    this.el = el; this.width = width; this.cells = []; this.last = null;
    el.classList.add("matrix", `matrix-${colour}`); el.setAttribute("role", "img");
    for (let c = 0; c < width; c++) {
      const ch = document.createElement("span"); ch.className = "mx-char";
      const dots = [];
      for (let i = 0; i < COLS * ROWS; i++) { const d = document.createElement("i"); ch.appendChild(d); dots.push(d); }
      el.appendChild(ch); this.cells.push(dots);
    }
  }
  render(text) {
    const t = fitText(text, this.width);
    if (t === this.last) return; this.last = t; this.el.setAttribute("aria-label", t.trim());
    for (let c = 0; c < this.width; c++) {
      const g = glyph(t[c]); const dots = this.cells[c];
      for (let r = 0; r < ROWS; r++) for (let x = 0; x < COLS; x++) dots[r * COLS + x].className = g[r][x] === "1" ? "on" : "";
    }
  }
  setDim(dim) { this.el.classList.toggle("dim", !!dim); }
  setFlash(flash) { this.el.classList.toggle("flash", !!flash); }
}
