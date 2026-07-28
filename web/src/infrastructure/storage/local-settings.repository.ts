/**
 * Adaptador de salida — Configuración en el almacenamiento del navegador.
 */
import { DEFAULT_SETTINGS, type LabSettings } from "@domain/settings";
import type { SettingsRepositoryPort } from "@application/ports/settings-repository.port";
import { readJson, writeJson } from "./browser-storage";

const KEY = "certiface:settings";

export function createLocalSettingsRepository(): SettingsRepositoryPort {
  const read = (): LabSettings => {
    const stored = readJson<Partial<LabSettings>>("local", KEY, {});
    return { ...DEFAULT_SETTINGS, ...stored };
  };

  return {
    read,

    save(patch: Partial<LabSettings>): LabSettings {
      const next: LabSettings = { ...read(), ...patch };
      writeJson("local", KEY, next);
      return next;
    },
  };
}
