const { app, Menu, dialog } = require("electron");

function send(getWindow, action) {
  const win = getWindow();
  if (win) win.webContents.send("menu:action", action);
}

module.exports = function buildMenu(getWindow) {
  const isMac = process.platform === "darwin";

  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "Archivo",
      submenu: [
        {
          label: "Abrir archivo…",
          accelerator: "CmdOrCtrl+O",
          click: () => send(getWindow, "open"),
        },
        {
          label: "Analizar",
          accelerator: "CmdOrCtrl+Return",
          click: () => send(getWindow, "analyze"),
        },
        {
          label: "Limpiar",
          accelerator: "CmdOrCtrl+R",
          click: () => send(getWindow, "reset"),
        },
        { type: "separator" },
        {
          label: "Configurar backend…",
          accelerator: "CmdOrCtrl+,",
          click: () => send(getWindow, "settings"),
        },
        { type: "separator" },
        {
          label: "Cerrar sesión",
          accelerator: "CmdOrCtrl+Shift+L",
          click: () => send(getWindow, "logout"),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit", label: "Salir" },
      ],
    },
    {
      label: "Ver",
      submenu: [
        { role: "reload", label: "Recargar" },
        { role: "toggleDevTools", label: "Herramientas de desarrollo" },
        { type: "separator" },
        { role: "resetZoom", label: "Zoom normal" },
        { role: "zoomIn", label: "Acercar" },
        { role: "zoomOut", label: "Alejar" },
        { role: "togglefullscreen", label: "Pantalla completa" },
      ],
    },
    {
      label: "Ayuda",
      submenu: [
        {
          label: "Acerca de",
          click: () => {
            dialog.showMessageBox(getWindow(), {
              type: "info",
              title: "Acerca de CertiFace",
              message: `CertiFace ${app.getVersion()}`,
              detail:
                "Laboratorio pericial de medios digitales para casos de " +
                "suplantación de identidad (face swap y deepfake).\n" +
                "Autoría: Alyce Maldonado.\n\n" +
                "El modelo fue entrenado con rostros generados por StyleGAN, por lo que " +
                "puede no generalizar a imágenes creadas con otros métodos de generación. " +
                "El dictamen es una opinión técnica preliminar, no una prueba concluyente.",
              buttons: ["Cerrar"],
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};
