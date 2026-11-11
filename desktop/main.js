// Alexandria Scoreboard — Windows desktop shell (Electron main process, ES module).
// Runs the same local server and page as the browser version, in-process, on a random loopback port.
// Offline by design: no network calls, no auto-update, no telemetry. The browser version (`npm start`) is unchanged.
//
//   npm run desktop                      dev run from the repo
//   npm run desktop -- --smoke=out.png   load, screenshot the real window to a PNG, exit 0 (used for verification)
//   npm run dist:win                     NSIS installer in dist/
import { app, BrowserWindow, Menu, shell, dialog, nativeImage } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createScoreboardServer, defaultDataDir } from "../packages/scoreboard/server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
const smoke = process.argv.find((a) => a.startsWith("--smoke="))?.slice(8) || null;

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId("com.alexandrialtd.scoreboard");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required"); // alert sounds without a first click

let server = null, baseUrl = null, win = null;

async function startServer() {
  const repoRoots = (process.env.SB_REPO_ROOTS || os.homedir()).split(";").filter(Boolean);
  server = createScoreboardServer({ port: 0, dataDir: process.env.SB_DATA_DIR || defaultDataDir(), repoRoots, log: () => {} });
  const port = await server.listen();
  baseUrl = `http://127.0.0.1:${port}/packages/scoreboard/`;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 920, minWidth: 720, minHeight: 520, backgroundColor: "#07080c", show: false,
    title: "Alexandria Scoreboard", autoHideMenuBar: false,
    icon: fs.existsSync(path.join(here, "..", "build", "icon.png")) ? nativeImage.createFromPath(path.join(here, "..", "build", "icon.png")) : undefined,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(here, "preload.cjs") },
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => (url.startsWith(baseUrl.replace("/packages/scoreboard/", "/")) ? { action: "allow", overrideBrowserWindowOptions: { backgroundColor: "#07080c", width: 1200, height: 860 } } : (shell.openExternal(url), { action: "deny" })));
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(baseUrl.replace("/packages/scoreboard/", "/"))) { e.preventDefault(); shell.openExternal(url); } });
  win.loadURL(baseUrl);
  Menu.setApplicationMenu(buildMenu());
  if (smoke) win.webContents.once("did-finish-load", () => setTimeout(async () => {
    try { const img = await win.webContents.capturePage(); fs.mkdirSync(path.dirname(smoke), { recursive: true }); fs.writeFileSync(smoke, img.toPNG()); console.log(`smoke: ${img.getSize().width}x${img.getSize().height} → ${smoke} · ${baseUrl}`); app.exit(0); }
    catch (err) { console.error(`smoke failed: ${err.message}`); app.exit(1); }
  }, 4000));
}

function setMode(mode) { win?.loadURL(mode === "live" ? baseUrl : `${baseUrl}?mode=${mode}`); }

function buildMenu() {
  const st = () => server?.status();
  return Menu.buildFromTemplate([
    { label: "Scoreboard", submenu: [
      { label: "Live", accelerator: "CmdOrCtrl+1", click: () => setMode("live") },
      { label: "Demo A · synthetic multi-agent", accelerator: "CmdOrCtrl+2", click: () => setMode("demo:synthetic-multi-agent") },
      { label: "Demo B · synthetic session (failing test, then fix)", accelerator: "CmdOrCtrl+3", click: () => setMode("demo:forge-demo-session") },
      { type: "separator" },
      { label: "Open data folder", click: () => shell.openPath(server ? path.dirname(server.marksFile) : defaultDataDir()) },
      { label: "Open hook log folder", click: () => shell.openPath(path.join(os.homedir(), ".claude", "eta")) },
      { type: "separator" },
      { role: "quit" },
    ] },
    { label: "View", submenu: [
      { label: "Always on top", type: "checkbox", accelerator: "CmdOrCtrl+T", click: (m) => win?.setAlwaysOnTop(m.checked, "floating") },
      { label: "Compact (70 %)", type: "checkbox", accelerator: "CmdOrCtrl+K", click: (m) => win?.webContents.setZoomFactor(m.checked ? 0.7 : 1) },
      { role: "togglefullscreen" }, { type: "separator" },
      { role: "zoomIn" }, { role: "zoomOut" }, { role: "resetZoom" }, { type: "separator" },
      { role: "reload" }, { role: "toggleDevTools" },
    ] },
    { label: "Help", submenu: [
      { label: "Scoreboard guide (docs/SCOREBOARD.md)", click: () => shell.openPath(path.join(here, "..", "docs", "SCOREBOARD.md")) },
      { label: "About", click: () => { const s = st(); dialog.showMessageBox(win, { type: "info", title: "Alexandria Scoreboard", message: `Alexandria Scoreboard ${pkg.version}`, detail: `Offline desktop shell · Electron ${process.versions.electron}\nLocal server ${baseUrl}\nHook log ${s?.sources.hookLog.file} (${s?.sources.hookLog.present ? s.sources.hookLog.events + " events" : "not found"})\nData ${server ? path.dirname(server.marksFile) : "–"}\nSessions ${s?.sessions.length ?? 0} · events ${s?.events ?? 0}\n\nAlexandria Ltd. Make the invisible work visible.` }); } },
    ] },
  ]);
}

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(async () => { try { await startServer(); createWindow(); } catch (err) { dialog.showErrorBox("Alexandria Scoreboard could not start", String(err?.stack || err)); app.exit(1); } });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { server?.close(); });
