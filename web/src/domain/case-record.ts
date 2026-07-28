/**
 * Dominio — Registro de casos.
 *
 * Bitácora corta de los últimos peritajes del equipo. Solo guarda el
 * resultado, nunca el material: la evidencia no sale de donde está.
 */
import type { Prediction } from "./verdict";
import type { EvidenceKind } from "./evidence";

export interface CaseRecord {
  name: string;
  prediction: Prediction;
  confidence: number;
  kind: EvidenceKind;
}

export const MAX_HISTORY = 5;

/** El caso más reciente encabeza la lista; la bitácora no crece sin fin. */
export function appendCase(
  history: readonly CaseRecord[],
  entry: CaseRecord,
): CaseRecord[] {
  return [entry, ...history].slice(0, MAX_HISTORY);
}
