/**
 * Puertos de salida — Credencial del perito y derivación de clave.
 *
 * Se separan a propósito: dónde se guarda el perfil (almacenamiento) y cómo
 * se protege la clave (criptografía) son decisiones independientes.
 */
import type { StoredCredential } from "@domain/analyst";

export interface CredentialRepositoryPort {
  readCredential(): StoredCredential | null;
  saveCredential(credential: StoredCredential): void;
  readSessionOpen(): boolean;
  saveSessionOpen(open: boolean): void;
}

export interface PasswordHasherPort {
  /** `false` cuando el entorno no ofrece criptografía fuerte. */
  available(): boolean;
  randomSalt(): string;
  /** Derivación lenta y determinista: misma clave + sal ⇒ mismo hash. */
  hash(pass: string, salt: string): Promise<string>;
  /** Comparación en tiempo constante. */
  matches(pass: string, credential: StoredCredential): Promise<boolean>;
}
