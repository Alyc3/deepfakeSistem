import { ANONYMOUS_SESSION, type Credentials, type Session } from "@domain/analyst";
import { fullName } from "@domain/identity";
import type { IdentityPort } from "@application/ports/identity.port";

export type LoginResult =
  | { ok: true; analyst: string }
  | { ok: false; mfaRequired: true }
  | { ok: false; mfaRequired?: false; error: string };

export const sessionStatus = (identity: IdentityPort) => (): Session => {
  const user = identity.current();
  return user ? { registered: true, loggedIn: true, analyst: fullName(user) } : { ...ANONYMOUS_SESSION };
};
const failure = (error: unknown, fallback: string): LoginResult =>
  ({ ok: false, error: error instanceof Error ? error.message : fallback });
export const loginAnalyst = (identity: IdentityPort) => async ({ user, pass }: Credentials): Promise<LoginResult> => {
  try {
    const outcome = await identity.login(user.trim(), pass);
    if (outcome.mfaRequired) return { ok: false, mfaRequired: true };
    return { ok: true, analyst: fullName(outcome.user) };
  } catch (error) { return failure(error, "No se pudo iniciar sesión."); }
};
/** Segundo paso del login cuando la cuenta tiene verificación en dos pasos. */
export const verifyAnalystMfa = (identity: IdentityPort) => async (code: string): Promise<LoginResult> => {
  try { return { ok: true, analyst: fullName(await identity.verifyMfa(code.replace(/\s+/g, ""))) }; }
  catch (error) { return failure(error, "No se pudo verificar el código."); }
};
export const logoutAnalyst = (identity: IdentityPort) => () => identity.logout();
