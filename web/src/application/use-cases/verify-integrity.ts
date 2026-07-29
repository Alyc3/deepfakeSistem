/**
 * Casos de uso — Cadena de custodia del material.
 *
 * Dos momentos, el mismo cálculo: al incorporar la evidencia (para dejar
 * constancia de su huella) y justo antes de analizarla (para comprobar que
 * sigue siendo la misma). El resultado nunca detiene el análisis.
 */
import type { EvidenceFile } from "@domain/evidence";
import {
  DEFAULT_ALGORITHM,
  algorithmFor,
  checkIntegrity,
  type IntegrityCheck,
} from "@domain/integrity";
import type { EvidenceDigestPort } from "@application/ports/evidence-digest.port";

/** Huella de referencia del material recién incorporado. */
export const digestEvidence =
  (digests: EvidenceDigestPort) =>
  (file: EvidenceFile, algorithm: string = DEFAULT_ALGORITHM): Promise<string | null> =>
    digests.digest(file, algorithm);

/**
 * Recalcula la huella del material que se va a analizar y la contrasta con
 * la que el perito anotó al recibirlo. El algoritmo se deduce de la huella
 * declarada (una de 40 dígitos es SHA-1, una de 64 es SHA-256…), de modo que
 * sirve el acta que traiga el caso.
 */
export const verifyIntegrity =
  (digests: EvidenceDigestPort) =>
  async (file: EvidenceFile, declared: string): Promise<IntegrityCheck> => {
    const algorithm = algorithmFor(declared) ?? DEFAULT_ALGORITHM;
    const computed = digests.supports(algorithm)
      ? await digests.digest(file, algorithm)
      : null;
    return checkIntegrity(computed, declared, algorithm);
  };

/** `false` cuando la conexión no permite criptografía en el navegador. */
export const digestsAvailable =
  (digests: EvidenceDigestPort) => (): boolean =>
    digests.available();
