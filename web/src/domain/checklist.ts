/**
 * Dominio — Peritaje manual.
 *
 * Cuando los modelos se quedan en INDICIOS, el dictamen lo resuelve el
 * perito: seis observaciones directas sobre el material que se ponderan con
 * la señal de los modelos. Toda la aritmética del desempate vive aquí.
 */
import type { Prediction } from "./verdict";

export type ChecklistAnswer = "si" | "no" | "nc";

export interface ChecklistItem {
  id: string;
  text: string;
  /** Qué respuesta apunta a manipulación. "No concluyente" no suma. */
  fakeAnswer: ChecklistAnswer;
}

export const CHECKLIST_ITEMS: readonly ChecklistItem[] = [
  {
    id: "bordes",
    text: "¿Los bordes del rostro (mandíbula, línea del pelo, orejas) muestran transiciones extrañas, dobles contornos o parpadeos?",
    fakeAnswer: "si",
  },
  {
    id: "gestos",
    text: "¿El parpadeo, la mirada, los dientes y las manos se comportan con naturalidad?",
    fakeAnswer: "no",
  },
  {
    id: "luz",
    text: "¿La iluminación y las sombras del rostro son coherentes con el resto de la escena?",
    fakeAnswer: "no",
  },
  {
    id: "filtros",
    text: "¿Se aprecian filtros de embellecimiento o procesado de cámara evidentes (piel uniformemente alisada)? Un filtro explica la señal de generación en material auténtico.",
    fakeAnswer: "no",
  },
  {
    id: "momentos",
    text: "¿Los momentos sospechosos señalados en el registro (si los hay) muestran artefactos visibles al revisarlos a mano en el reproductor?",
    fakeAnswer: "si",
  },
  {
    id: "origen",
    text: "¿El origen del material es verificable (fuente conocida, cadena de custodia)?",
    fakeAnswer: "no",
  },
];

export const ANSWER_LABELS: Record<ChecklistAnswer, string> = {
  si: "Sí",
  no: "No",
  nc: "No concluyente",
};

export type ChecklistAnswers = Partial<Record<string, ChecklistAnswer>>;

export interface ChecklistScores {
  /** Puntos hacia manipulación, incluidos los que aportan los modelos. */
  fake: number;
  /** Puntos hacia autenticidad. */
  real: number;
  /** Peso con el que entraron los modelos. */
  modelPoints: number;
  answered: number;
  total: number;
  complete: boolean;
}

/**
 * La señal de los modelos entra en el cómputo: fuerte (≥ 50 %) pesa doble.
 */
export function computeChecklistScores(
  answers: ChecklistAnswers,
  modelConfidence: number,
): ChecklistScores {
  const modelPoints = modelConfidence >= 50 ? 2 : 1;
  let fake = modelPoints;
  let real = 0;
  let answered = 0;

  for (const item of CHECKLIST_ITEMS) {
    const answer = answers[item.id];
    if (!answer) continue;
    answered += 1;
    if (answer === "nc") continue;
    if (answer === item.fakeAnswer) fake += 1;
    else real += 1;
  }

  return {
    fake,
    real,
    modelPoints,
    answered,
    total: CHECKLIST_ITEMS.length,
    complete: answered === CHECKLIST_ITEMS.length,
  };
}

export type ManualVerdict =
  | { outcome: "tie"; scores: ChecklistScores }
  | { outcome: "resolved"; prediction: Prediction; scores: ChecklistScores };

/**
 * Resuelve los indicios. El empate no se rompe a la fuerza: se mantiene el
 * dictamen con reserva, que es la conclusión honesta cuando la observación
 * directa no inclina la balanza.
 */
export function resolveManualVerdict(
  answers: ChecklistAnswers,
  modelConfidence: number,
): ManualVerdict {
  const scores = computeChecklistScores(answers, modelConfidence);
  if (scores.fake === scores.real) return { outcome: "tie", scores };
  return {
    outcome: "resolved",
    prediction: scores.fake > scores.real ? "Fake" : "Real",
    scores,
  };
}
