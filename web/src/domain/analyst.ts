/**
 * Dominio — Sesión del perito.
 *
 * Estado de acceso visible en la interfaz. La identidad se valida en el servicio de usuarios.
 */

export interface Credentials {
  user: string;
  pass: string;
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
