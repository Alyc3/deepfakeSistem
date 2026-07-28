/**
 * Puerto de salida — Persistencia del registro de casos.
 */
import type { CaseRecord } from "@domain/case-record";

export interface CaseRepositoryPort {
  list(): CaseRecord[];
  add(entry: CaseRecord): CaseRecord[];
  clear(): CaseRecord[];
}
