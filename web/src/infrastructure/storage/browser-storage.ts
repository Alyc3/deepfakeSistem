/**
 * Utilidad compartida de los adaptadores de almacenamiento.
 *
 * El almacenamiento del navegador puede no existir (renderizado en el
 * servidor durante la construcción del sitio) o estar bloqueado por la
 * política de privacidad. En ambos casos el laboratorio debe seguir
 * funcionando, aunque sin recordar nada entre visitas.
 */

export type StorageKind = "local" | "session";

function pick(kind: StorageKind): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    const storage = kind === "local" ? window.localStorage : window.sessionStorage;
    // Comprobación real de escritura: en modo privado el objeto existe pero
    // lanza al escribir.
    const probe = "__certiface__";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

export function readJson<T>(kind: StorageKind, key: string, fallback: T): T {
  const storage = pick(kind);
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    // Contenido corrupto: se descarta y se sigue con el valor por defecto.
    return fallback;
  }
}

export function writeJson(kind: StorageKind, key: string, value: unknown): void {
  const storage = pick(kind);
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.error("[CertiFace] No se pudo guardar en el navegador:", err);
  }
}
