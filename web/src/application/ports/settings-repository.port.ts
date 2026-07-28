/**
 * Puerto de salida — Persistencia de la configuración.
 */
import type { LabSettings } from "@domain/settings";

export interface SettingsRepositoryPort {
  read(): LabSettings;
  save(patch: Partial<LabSettings>): LabSettings;
}
