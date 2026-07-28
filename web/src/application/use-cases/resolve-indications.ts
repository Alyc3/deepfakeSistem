/**
 * Caso de uso — Resolver un dictamen con reserva (INDICIOS).
 *
 * Combina las respuestas del peritaje manual con la señal de los modelos.
 * No necesita puertos: es decisión, no infraestructura.
 */
import {
  computeChecklistScores,
  resolveManualVerdict,
  type ChecklistAnswers,
  type ChecklistScores,
  type ManualVerdict,
} from "@domain/checklist";

export const scoreIndications =
  () =>
  (answers: ChecklistAnswers, modelConfidence: number): ChecklistScores =>
    computeChecklistScores(answers, modelConfidence);

export const resolveIndications =
  () =>
  (answers: ChecklistAnswers, modelConfidence: number): ManualVerdict =>
    resolveManualVerdict(answers, modelConfidence);
