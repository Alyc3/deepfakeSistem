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

export function createLocalCaseRepository(): CaseRepositoryPort {
  const read = (): CaseRecord[] => readJson<CaseRecord[]>("local", KEY, []);

  return {
    list: read,

    add(entry: CaseRecord): CaseRecord[] {
      const next = appendCase(read(), entry);
      writeJson("local", KEY, next);
      return next;
    },

    clear(): CaseRecord[] {
      writeJson("local", KEY, []);
      return [];
    },
  };
}
