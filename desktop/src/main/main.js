const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
} = require("electron");

const api = require("./api");
const auth = require("./auth");
const store = require("./store");
const buildMenu = require("./menu");

const isDev = process.argv.includes("--dev");

// Ruta cuyo contenido puede leer el renderer para la vista previa. Solo se
// autoriza el archivo seleccionado en cada momento, para que la ventana no
// pueda leer un archivo arbitrario del disco a través del IPC.
const allowedPreviewPaths = new Set();

let mainWindow = null;

function assetPath(name) {
  return path.join(__dirname, "..", "..", "assets", name);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 720,
    minHeight: 640,
    show: false,
    backgroundColor: "#100c0b",
    title: "CertiFace — Peritaje de Medios Digitales",
    icon: path.join(__dirname, "..", "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: "detach" });
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Los enlaces externos se abren en el navegador del sistema, nunca dentro
  // de la ventana de la aplicación.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

function registerIpc() {
  ipcMain.handle("settings:get", () => store.read());

  ipcMain.handle("settings:set", (_event, patch) => {
    const allowed = {};
    if (typeof patch?.apiUrl === "string") allowed.apiUrl = patch.apiUrl.trim();
    return store.write(allowed);
  });

  ipcMain.handle("auth:status", () => auth.status());
  ipcMain.handle("auth:register", (_event, { user, pass }) => auth.register(user, pass));
  ipcMain.handle("auth:login", (_event, { user, pass }) => auth.login(user, pass));
  ipcMain.handle("auth:logout", () => auth.logout());

  ipcMain.handle("history:add", (_event, entry) => store.pushHistory(entry));
  ipcMain.handle("history:clear", () => store.write({ history: [] }).history);

  ipcMain.handle("dialog:pickFile", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: "Selecciona una imagen o un video",
      properties: ["openFile"],
      filters: [
        {
          name: "Imágenes y videos",
          extensions: [...api.IMAGE_EXTENSIONS, ...api.VIDEO_EXTENSIONS].map((e) =>
            e.replace(".", "")
          ),
        },
        { name: "Todos los archivos", extensions: ["*"] },
      ],
    });
    if (canceled || filePaths.length === 0) return { ok: false, canceled: true };
    return prepareFile(filePaths[0]);
  });

  ipcMain.handle("file:prepare", (_event, filePath) => prepareFile(filePath));

  ipcMain.handle("file:sample", (_event, which) => {
    const name = which === "fake" ? "sample-fake.jpg" : "sample-real.jpg";
    return prepareFile(assetPath(name));
  });

  // Entrega los bytes del archivo autorizado para la vista previa. El
  // renderer los convierte en un Blob URL, con el que el reproductor de
  // Chromium tiene búsqueda y duración nativas (el archivo está acotado a
  // 10 MB por la validación previa, así que cargarlo en memoria es barato).
  ipcMain.handle("file:preview", async (_event, filePath) => {
    const normalized = path.normalize(String(filePath ?? ""));
    if (!allowedPreviewPaths.has(normalized)) {
      return { ok: false, error: "Archivo no autorizado para vista previa." };
    }
    try {
      const buffer = await fsp.readFile(normalized);
      return { ok: true, bytes: buffer, mime: api.mimeFor(normalized) };
    } catch {
      return { ok: false, error: "No se pudo leer el archivo." };
    }
  });

  ipcMain.handle("api:predict", (_event, { apiUrl, filePath }) =>
    api.predict(apiUrl, filePath)
  );

  ipcMain.handle("api:health", (_event, apiUrl) => api.checkHealth(apiUrl));
}

async function prepareFile(filePath) {
  const inspection = await api.inspectFile(filePath);
  if (!inspection.ok) return inspection;
  allowedPreviewPaths.clear();
  allowedPreviewPaths.add(path.normalize(inspection.file.path));
  return { ok: true, file: inspection.file };
}

// Una sola instancia: si el usuario abre la app de nuevo, se enfoca la ventana
// existente en lugar de arrancar un segundo proceso.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpc();
    createWindow();
    buildMenu(() => mainWindow);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // En macOS es habitual que la aplicación siga activa sin ventanas abiertas.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
