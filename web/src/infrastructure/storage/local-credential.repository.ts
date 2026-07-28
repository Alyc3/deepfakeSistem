/**
 * Adaptador de salida — Perfil del perito en el navegador.
 *
 * La credencial (usuario, sal y hash) persiste en `localStorage`: sobrevive
 * al cierre del navegador, igual que el perfil del cliente de escritorio.
 * La sesión abierta vive en `sessionStorage`: cerrar la pestaña cierra la
 * sesión, que es lo prudente en un equipo compartido.
 */
import type { StoredCredential } from "@domain/analyst";
import type { CredentialRepositoryPort } from "@application/ports/credential-repository.port";
import { readJson, writeJson } from "./browser-storage";

const CREDENTIAL_KEY = "certiface:credential";
const SESSION_KEY = "certiface:session";

export function createLocalCredentialRepository(): CredentialRepositoryPort {
  return {
    readCredential(): StoredCredential | null {
      const stored = readJson<StoredCredential | null>("local", CREDENTIAL_KEY, null);
      if (!stored?.user || !stored.salt || !stored.hash) return null;
      return stored;
    },

    saveCredential(credential: StoredCredential): void {
      writeJson("local", CREDENTIAL_KEY, credential);
    },

    readSessionOpen(): boolean {
      return readJson<boolean>("session", SESSION_KEY, false) === true;
    },

    saveSessionOpen(open: boolean): void {
      writeJson("session", SESSION_KEY, open);
    },
  };
}
