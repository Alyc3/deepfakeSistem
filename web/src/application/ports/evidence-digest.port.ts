/**
 * Puerto de salida — Huella criptográfica del material.
 *
 * Qué necesita el laboratorio para verificar la cadena de custodia, sin
 * decir con qué API se calcula.
 */
import type { EvidenceFile } from "@domain/evidence";

export interface EvidenceDigestPort {
  /** `false` cuando el entorno no ofrece criptografía (conexión insegura). */
  available(): boolean;
  /** Algoritmos que este adaptador puede calcular. */
  supports(algorithm: string): boolean;
  /** Huella en hexadecimal minúsculo, o `null` si no pudo calcularse. */
  digest(file: EvidenceFile, algorithm: string): Promise<string | null>;
}
