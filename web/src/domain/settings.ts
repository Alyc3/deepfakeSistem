/**
 * Dominio — Configuración del laboratorio.
 *
 * Lo único configurable es dónde vive la API pericial. El valor por defecto
 * apunta al backend local del propio perito.
 */

export interface LabSettings {
  apiUrl: string;
}

export const DEFAULT_SETTINGS: LabSettings = {
  apiUrl: "http://127.0.0.1:8000",
};

/** Sin barra final: todas las rutas se componen con `${base}/algo`. */
export const normalizeBaseUrl = (apiUrl: string): string =>
  String(apiUrl ?? "").trim().replace(/\/+$/, "");

export const isValidApiUrl = (value: string): boolean =>
  /^https?:\/\/.+/i.test(value.trim());
