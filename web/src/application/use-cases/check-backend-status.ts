/**
 * Caso de uso — Comprobar si el backend pericial responde.
 */
import type { BackendStatus, ForensicsApiPort } from "@application/ports/forensics-api.port";

export const checkBackendStatus =
  (api: ForensicsApiPort) => (): Promise<BackendStatus> =>
    api.status();
