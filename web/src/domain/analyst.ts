/**
 * Dominio — Perito.
 *
 * Control de acceso al puesto de trabajo de un solo perfil. No es un sistema
 * de identidad multiusuario: es la firma de quien opera el laboratorio.
 */

export interface Credentials {
  user: string;
  pass: string;
}

/** Credencial almacenada: la clave nunca se guarda en claro. */
export interface StoredCredential {
  user: string;
  salt: string;
  hash: string;
}

export interface Session {
  registered: boolean;
  loggedIn: boolean;
  analyst: string | null;
}

export const ANONYMOUS_SESSION: Session = {
  registered: false,
  loggedIn: false,
  analyst: null,
};

export const MIN_USER_LENGTH = 3;
export const MIN_PASS_LENGTH = 6;

/** Devuelve el motivo del rechazo, o `null` si la credencial es admisible. */
export function validateCredentials({ user, pass }: Credentials): string | null {
  if (typeof user !== "string" || user.trim().length < MIN_USER_LENGTH) {
    return `La credencial debe tener al menos ${MIN_USER_LENGTH} caracteres.`;
  }
  if (typeof pass !== "string" || pass.length < MIN_PASS_LENGTH) {
    return `La clave debe tener al menos ${MIN_PASS_LENGTH} caracteres.`;
  }
  return null;
}
