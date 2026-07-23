const crypto = require("node:crypto");
const store = require("./store");

// Autenticación local de un solo perfil. La clave nunca se guarda en claro:
// se deriva con scrypt y se compara en tiempo constante. Es un control de
// acceso al puesto de trabajo, no un sistema de identidad multiusuario.

const SCRYPT_LEN = 64;

function status() {
  const { auth, session } = store.read();
  return {
    registered: Boolean(auth.hash),
    loggedIn: Boolean(session.loggedIn && auth.hash),
    analyst: auth.user,
  };
}

function validate(user, pass) {
  if (typeof user !== "string" || user.trim().length < 3) {
    return "La credencial debe tener al menos 3 caracteres.";
  }
  if (typeof pass !== "string" || pass.length < 6) {
    return "La clave debe tener al menos 6 caracteres.";
  }
  return null;
}

function register(user, pass) {
  const invalid = validate(user, pass);
  if (invalid) return { ok: false, error: invalid };

  if (store.read().auth.hash) {
    return { ok: false, error: "Ya existe un perfil registrado en este equipo." };
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pass, salt, SCRYPT_LEN).toString("hex");
  store.write({
    auth: { user: user.trim(), salt, hash },
    session: { loggedIn: true },
  });
  return { ok: true, analyst: user.trim() };
}

function login(user, pass) {
  const { auth } = store.read();
  if (!auth.hash) {
    return { ok: false, error: "No hay ningún perfil registrado todavía." };
  }

  const candidate = crypto.scryptSync(String(pass ?? ""), auth.salt, SCRYPT_LEN);
  const stored = Buffer.from(auth.hash, "hex");
  const passOk = crypto.timingSafeEqual(candidate, stored);
  const userOk = String(user ?? "").trim() === auth.user;

  if (!passOk || !userOk) {
    return { ok: false, error: "Credencial o clave incorrectas." };
  }

  store.write({ session: { loggedIn: true } });
  return { ok: true, analyst: auth.user };
}

function logout() {
  store.write({ session: { loggedIn: false } });
  return { ok: true };
}

module.exports = { status, register, login, logout };
