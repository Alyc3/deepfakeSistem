import { IdentityError } from "@domain/identity";

/** Mensaje de un error para mostrar al usuario, con los motivos de la política de contraseñas si los hay. */
export function describeError(error: unknown, fallback: string): string {
  if (error instanceof IdentityError && error.errors.length) return [error.message, ...error.errors].join(" · ");
  return error instanceof Error && error.message ? error.message : fallback;
}
