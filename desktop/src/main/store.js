const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const DEFAULTS = {
  apiUrl: "http://127.0.0.1:8000",
  history: [],
  // Perfil local del perito: credencial + clave con hash scrypt. Solo existe
  // en este equipo; no hay servidor de identidad.
  auth: { user: null, salt: null, hash: null },
  session: { loggedIn: false },
};

const MAX_HISTORY = 5;

function configPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function read() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const data = JSON.parse(raw);
    return {
      ...DEFAULTS,
      ...data,
      auth: { ...DEFAULTS.auth, ...data.auth },
      session: { ...DEFAULTS.session, ...data.session },
    };
  } catch {
    // Primer arranque o archivo corrupto: se usan los valores por defecto.
    return structuredClone(DEFAULTS);
  }
}

function write(patch) {
  const next = { ...read(), ...patch };
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), "utf8");
  } catch (err) {
    console.error("No se pudo guardar la configuración:", err.message);
  }
  return next;
}

function pushHistory(entry) {
  const history = [entry, ...read().history].slice(0, MAX_HISTORY);
  return write({ history }).history;
}

module.exports = { read, write, pushHistory, DEFAULTS };
