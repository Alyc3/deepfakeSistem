/**
 * Casos de uso — Configuración del laboratorio.
 */
import { isValidApiUrl, type LabSettings } from "@domain/settings";
import type { SettingsRepositoryPort } from "@application/ports/settings-repository.port";

export type SettingsOutcome =
  | { ok: true; settings: LabSettings }
  | { ok: false; error: string };

export const readSettings =
  (settings: SettingsRepositoryPort) => (): LabSettings =>
    settings.read();

export const saveApiUrl =
  (settings: SettingsRepositoryPort) =>
  (apiUrl: string): SettingsOutcome => {
    if (!isValidApiUrl(apiUrl)) {
      return {
        ok: false,
        error: "Introduce una URL válida que empiece por http:// o https://",
      };
    }
    return { ok: true, settings: settings.save({ apiUrl: apiUrl.trim() }) };
  };
