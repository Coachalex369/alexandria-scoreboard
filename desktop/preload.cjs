// Minimal preload: the page only needs to know it runs inside the desktop shell (to enable sound without a click).
const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("alexandriaDesktop", { shell: "electron", version: process.versions.electron });
