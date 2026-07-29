/**
 * Adaptador de salida — Huella del material con la API Web Crypto.
 *
 * El material está acotado a 10 MB por las reglas de admisión, así que se
 * digiere de una sola vez en memoria: sobre un archivo de ese tamaño la
 * huella sale en decenas de milisegundos.
 *
 * `crypto.subtle` solo existe en contextos seguros (https:// o localhost).
 * Servir el laboratorio por http:// contra una IP deja la verificación de
 * integridad fuera de alcance, y entonces se dice con claridad en lugar de
 * fingir una comprobación que no se hizo.
 */
import type { EvidenceFile } from "@domain/evidence";
import { ALGORITHM_BY_LENGTH } from "@domain/integrity";
import type { EvidenceDigestPort } from "@application/ports/evidence-digest.port";

const SUPPORTED = new Set(Object.values(ALGORITHM_BY_LENGTH));

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export function createWebCryptoDigest(): EvidenceDigestPort {
  const subtle = (): SubtleCrypto | null =>
    typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle
      ? globalThis.crypto.subtle
      : null;

  return {
    available: () => subtle() !== null,

    supports: (algorithm: string) => SUPPORTED.has(algorithm),

    async digest(file: EvidenceFile, algorithm: string): Promise<string | null> {
      const api = subtle();
      if (!api || !SUPPORTED.has(algorithm)) return null;
      try {
        const bytes = await file.blob.arrayBuffer();
        return toHex(await api.digest(algorithm, bytes));
      } catch (err) {
        console.error("[CertiFace] No se pudo calcular la huella:", err);
        return null;
      }
    },
  };
}
