/**
 * Adaptador de salida — Registro de casos en el almacenamiento del navegador.
 *
 * Solo se persiste el resultado del peritaje (nombre, dictamen, confianza).
 * El material nunca se guarda: no sale del equipo del perito.
 */
import { appendCase, type CaseRecord } from "@domain/case-record";
import type { CaseRepositoryPort } from "@application/ports/case-repository.port";
import { readJson, writeJson } from "./browser-storage";

const KEY = "certiface:history";

export function createLocalCaseRepository(userId: () => string | null): CaseRepositoryPort {
  const read = (): CaseRecord[] => userId() ? readJson<CaseRecord[]>("local", `${KEY}:${userId()}`, []) : [];

  return {
    list: read,

    add(entry: CaseRecord): CaseRecord[] {
      const next = appendCase(read(), entry);
      writeJson("local", `${KEY}:${userId()}`, next);
      return next;
    },

    clear(): CaseRecord[] {
      writeJson("local", `${KEY}:${userId()}`, []);
      return [];
    },
  };
}
