const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Superficie mínima expuesta al renderer. No hay acceso directo a Node ni a
// ipcRenderer desde la interfaz: solo estas funciones concretas.
contextBridge.exposeInMainWorld("api", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:set", patch),

  authStatus: () => ipcRenderer.invoke("auth:status"),
  register: (credentials) => ipcRenderer.invoke("auth:register", credentials),
  login: (credentials) => ipcRenderer.invoke("auth:login", credentials),
  logout: () => ipcRenderer.invoke("auth:logout"),

  addHistory: (entry) => ipcRenderer.invoke("history:add", entry),
  clearHistory: () => ipcRenderer.invoke("history:clear"),

  pickFile: () => ipcRenderer.invoke("dialog:pickFile"),
  prepareFile: (filePath) => ipcRenderer.invoke("file:prepare", filePath),
  loadSample: (which) => ipcRenderer.invoke("file:sample", which),
  readPreview: (filePath) => ipcRenderer.invoke("file:preview", filePath),

  predict: (apiUrl, filePath) => ipcRenderer.invoke("api:predict", { apiUrl, filePath }),
  checkHealth: (apiUrl) => ipcRenderer.invoke("api:health", apiUrl),

  // Desde Electron 32 el objeto File ya no expone .path; esta es la vía
  // soportada para obtener la ruta real de un archivo arrastrado a la ventana.
  pathForFile: (file) => webUtils.getPathForFile(file),

  onMenuAction: (handler) => {
    ipcRenderer.on("menu:action", (_event, action) => handler(action));
  },
});
