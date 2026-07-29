/**
 * Dominio — Integridad del material (cadena de custodia).
 *
 * Al recibir una evidencia se anota su huella criptográfica. Antes de
 * analizarla se vuelve a calcular sobre el archivo que se va a examinar: si
 * las dos coinciden, el material es bit a bit el mismo que se recibió; si no,
 * algo lo alteró por el camino (recorte, recompresión, sustitución).
 *
 * La comprobación **nunca bloquea el análisis**. Un perito puede querer
 * examinar material alterado precisamente porque está alterado; lo que el
 * sistema debe hacer es advertirlo y dejar constancia, no decidir por él.
 */

/** Algoritmos que ofrece el navegador, indexados por longitud del hash. */
export const ALGORITHM_BY_LENGTH: Record<number, string> = {
  40: "SHA-1",
  64: "SHA-256",
  96: "SHA-384",
  128: "SHA-512",
};

/** El estándar forense y el que se muestra por defecto. */
export const DEFAULT_ALGORITHM = "SHA-256";

/** MD5 sigue apareciendo en actas antiguas, pero Web Crypto no lo implementa. */
export const MD5_LENGTH = 32;

export type IntegrityStatus =
  /** No se declaró huella de recepción: no hay nada que comparar. */
  | "unverified"
  /** La huella declarada no es un hash reconocible. */
  | "unreadable"
  /** El algoritmo de la huella declarada no está disponible aquí. */
  | "unsupported"
  /** Coinciden: el material no ha cambiado. */
  | "match"
  /** No coinciden: el material no es el que se recibió. */
  | "mismatch";

export interface IntegrityCheck {
  status: IntegrityStatus;
  /** Huella recalculada sobre el archivo que se va a analizar. */
  computed: string | null;
  /** Huella declarada por el perito, ya normalizada. */
  declared: string | null;
  /** Algoritmo aplicado en la comparación. */
  algorithm: string;
}

/**
 * Las actas traen la huella con mayúsculas, espacios cada cuatro dígitos o
 * prefijos del estilo "sha256:". Todo eso es la misma huella.
 */
export function normalizeDigest(value: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^(sha-?\d{1,3}|md5)\s*[:=]\s*/, "")
    .replace(/[\s:-]/g, "");
}

export const isHexDigest = (value: string): boolean => /^[0-9a-f]+$/.test(value);

/** Algoritmo que corresponde a una huella declarada, por su longitud. */
export function algorithmFor(declared: string): string | null {
  return ALGORITHM_BY_LENGTH[normalizeDigest(declared).length] ?? null;
}

/** Comparación en tiempo constante: no hay secretos, pero cuesta lo mismo. */
function equalDigests(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Contrasta la huella recalculada con la declarada en la recepción.
 * `computed` debe venir del mismo algoritmo que devuelve `algorithmFor`.
 */
export function checkIntegrity(
  computed: string | null,
  declaredRaw: string,
  algorithm: string = DEFAULT_ALGORITHM,
): IntegrityCheck {
  const declared = normalizeDigest(declaredRaw);
  const base = { computed, declared: declared || null, algorithm };

  if (!declared) return { ...base, status: "unverified" };
  if (!isHexDigest(declared)) return { ...base, status: "unreadable" };
  if (declared.length === MD5_LENGTH) return { ...base, status: "unsupported" };
  if (!ALGORITHM_BY_LENGTH[declared.length]) {
    return { ...base, status: "unreadable" };
  }
  if (!computed) return { ...base, status: "unverified" };

  return {
    ...base,
    status: equalDigests(computed, declared) ? "match" : "mismatch",
  };
}

/** Huella abreviada para el registro y la bitácora: primeros y últimos dígitos. */
export const shortDigest = (digest: string): string =>
  digest.length > 20 ? `${digest.slice(0, 12)}…${digest.slice(-8)}` : digest;
