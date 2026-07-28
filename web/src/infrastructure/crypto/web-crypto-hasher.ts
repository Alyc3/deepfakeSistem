/**
 * Adaptador de salida — Derivación de clave con la API Web Crypto.
 *
 * El cliente de escritorio usaba scrypt de Node; en el navegador el
 * equivalente disponible es PBKDF2-SHA-256 con muchas iteraciones. La clave
 * nunca se guarda en claro y la comparación es en tiempo constante.
 *
 * `crypto.subtle` solo existe en contextos seguros: https:// o localhost.
 * Servir el laboratorio por http:// contra una IP de la red deja la
 * criptografía fuera de alcance, y entonces el acceso se rechaza con un
 * mensaje explícito en lugar de degradarse en silencio a algo inseguro.
 */
import type { StoredCredential } from "@domain/analyst";
import type { PasswordHasherPort } from "@application/ports/credential-repository.port";

const ITERATIONS = 210_000;
const KEY_LENGTH_BITS = 512; // 64 bytes, como el scrypt del cliente de escritorio
const SALT_BYTES = 16;

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export function createWebCryptoHasher(): PasswordHasherPort {
  const subtle = (): SubtleCrypto | null =>
    typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle
      ? globalThis.crypto.subtle
      : null;

  const hash = async (pass: string, salt: string): Promise<string> => {
    const api = subtle();
    if (!api) throw new Error("Web Crypto no disponible en este contexto.");

    const encoder = new TextEncoder();
    const material = await api.importKey(
      "raw",
      encoder.encode(pass),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await api.deriveBits(
      {
        name: "PBKDF2",
        salt: encoder.encode(salt),
        iterations: ITERATIONS,
        hash: "SHA-256",
      },
      material,
      KEY_LENGTH_BITS,
    );
    return toHex(bits);
  };

  return {
    available: () => subtle() !== null,

    randomSalt(): string {
      const bytes = new Uint8Array(SALT_BYTES);
      globalThis.crypto.getRandomValues(bytes);
      return toHex(bytes.buffer);
    },

    hash,

    async matches(pass: string, credential: StoredCredential): Promise<boolean> {
      const candidate = await hash(pass, credential.salt);
      // Comparación en tiempo constante: el bucle recorre siempre la longitud
      // completa, sin salir antes en la primera diferencia.
      if (candidate.length !== credential.hash.length) return false;
      let diff = 0;
      for (let i = 0; i < candidate.length; i += 1) {
        diff |= candidate.charCodeAt(i) ^ credential.hash.charCodeAt(i);
      }
      return diff === 0;
    },
  };
}
