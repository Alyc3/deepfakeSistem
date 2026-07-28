/**
 * Casos de uso — Sesión del perito.
 *
 * Registro de primer uso, identificación y cierre de sesión. La política
 * (una credencial por equipo, clave nunca en claro) es del núcleo; el cómo
 * se guarda y con qué algoritmo se deriva, de los adaptadores.
 */
import {
  ANONYMOUS_SESSION,
  validateCredentials,
  type Credentials,
  type Session,
} from "@domain/analyst";
import type {
  CredentialRepositoryPort,
  PasswordHasherPort,
} from "@application/ports/credential-repository.port";

export type AuthOutcome =
  | { ok: true; analyst: string }
  | { ok: false; error: string };

const NO_CRYPTO =
  "Este navegador no ofrece criptografía segura en la conexión actual. " +
  "Abre el laboratorio en https:// o en http://localhost.";

interface AuthDeps {
  credentials: CredentialRepositoryPort;
  hasher: PasswordHasherPort;
}

export const sessionStatus =
  ({ credentials }: AuthDeps) =>
  (): Session => {
    const stored = credentials.readCredential();
    if (!stored) return { ...ANONYMOUS_SESSION };
    return {
      registered: true,
      loggedIn: credentials.readSessionOpen(),
      analyst: stored.user,
    };
  };

export const registerAnalyst =
  ({ credentials, hasher }: AuthDeps) =>
  async ({ user, pass }: Credentials): Promise<AuthOutcome> => {
    const invalid = validateCredentials({ user, pass });
    if (invalid) return { ok: false, error: invalid };
    if (!hasher.available()) return { ok: false, error: NO_CRYPTO };

    if (credentials.readCredential()) {
      return { ok: false, error: "Ya existe un perfil registrado en este equipo." };
    }

    const salt = hasher.randomSalt();
    const hash = await hasher.hash(pass, salt);
    const analyst = user.trim();
    credentials.saveCredential({ user: analyst, salt, hash });
    credentials.saveSessionOpen(true);
    return { ok: true, analyst };
  };

export const loginAnalyst =
  ({ credentials, hasher }: AuthDeps) =>
  async ({ user, pass }: Credentials): Promise<AuthOutcome> => {
    const stored = credentials.readCredential();
    if (!stored) {
      return { ok: false, error: "No hay ningún perfil registrado todavía." };
    }
    if (!hasher.available()) return { ok: false, error: NO_CRYPTO };

    const passOk = await hasher.matches(String(pass ?? ""), stored);
    const userOk = String(user ?? "").trim() === stored.user;
    if (!passOk || !userOk) {
      return { ok: false, error: "Credencial o clave incorrectas." };
    }

    credentials.saveSessionOpen(true);
    return { ok: true, analyst: stored.user };
  };

export const logoutAnalyst =
  ({ credentials }: AuthDeps) =>
  (): void => {
    credentials.saveSessionOpen(false);
  };
