/**
 * Casos de uso — Registro de casos del equipo.
 */
import type { CaseRecord } from "@domain/case-record";
import type { CaseRepositoryPort } from "@application/ports/case-repository.port";

export const listCases = (cases: CaseRepositoryPort) => (): CaseRecord[] =>
  cases.list();

export const recordCase =
  (cases: CaseRepositoryPort) =>
  (entry: CaseRecord): CaseRecord[] =>
    cases.add(entry);

export const clearCases = (cases: CaseRepositoryPort) => (): CaseRecord[] =>
  cases.clear();
