import { ANONYMOUS_SESSION, type Credentials, type Session } from "@domain/analyst";
import type { IdentityPort } from "@application/ports/identity.port";
export const sessionStatus = (identity: IdentityPort) => (): Session => {
  const user = identity.current();
  return user ? { registered: true, loggedIn: true,
    analyst: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email,
  } : { ...ANONYMOUS_SESSION };
};
export const loginAnalyst = (identity: IdentityPort) => async ({ user, pass }: Credentials) => {
  try {
    await identity.login(user.trim(), pass);
    return { ok: true as const, analyst: sessionStatus(identity)().analyst! };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "No se pudo iniciar sesión." };
  }
};
export const logoutAnalyst = (identity: IdentityPort) => () => identity.logout();
