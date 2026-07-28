/**
 * Interfaz — Peritaje manual para resolver los dictámenes con reserva.
 *
 * Las seis preguntas y toda la aritmética del desempate viven en el dominio;
 * aquí solo se pintan, se recogen las respuestas y se estampa el resultado.
 */
import { ANSWER_LABELS, CHECKLIST_ITEMS, type ChecklistAnswer } from "@domain/checklist";
import { verdictOf } from "@domain/verdict";
import { el } from "../dom";
import { state } from "../state";
import { lab } from "../lab";
import { addLog } from "../analysis-log";
import { showToast } from "../toast";
import { stampFinalVerdict } from "./result.presenter";
import { renderHistory } from "./history.presenter";

const OPTIONS: ChecklistAnswer[] = ["si", "no", "nc"];

export function showChecklist(): void {
  state.checklistAnswers = {};
  el.checklistItems.replaceChildren();

  for (const item of CHECKLIST_ITEMS) {
    const wrap = document.createElement("div");
    wrap.className = "checklist-item";

    const question = document.createElement("p");
    question.className = "checklist-question";
    question.textContent = item.text;

    const options = document.createElement("div");
    options.className = "checklist-options";
    for (const value of OPTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "check-option";
      button.textContent = ANSWER_LABELS[value];
      button.addEventListener("click", () => {
        state.checklistAnswers[item.id] = value;
        for (const sibling of options.children) sibling.classList.remove("selected");
        button.classList.add("selected");
        updateChecklistScore();
      });
      options.appendChild(button);
    }

    wrap.append(question, options);
    el.checklistItems.appendChild(wrap);
  }

  el.checklist.hidden = false;
  updateChecklistScore();
}

export function updateChecklistScore(): void {
  const confidence = state.lastResult?.confidence ?? 0;
  const scores = lab().scoreIndications(state.checklistAnswers, confidence);

  el.checklistScore.textContent =
    `${scores.answered}/${scores.total} RESPONDIDAS · ` +
    `MANIPULACIÓN ${scores.fake} (MODELOS ${scores.modelPoints}) · AUTENTICIDAD ${scores.real}`;
  el.checklistSubmit.disabled = !scores.complete;
}

export function emitFinalVerdict(): void {
  const result = state.lastResult;
  if (!result) return;

  const resolution = lab().resolveIndications(state.checklistAnswers, result.confidence);
  const { fake, real } = resolution.scores;

  if (resolution.outcome === "tie") {
    addLog(
      `Peritaje manual: empate técnico (${fake} · ${real}); los indicios se mantienen — ` +
        `amplía la revisión o incorpora más material`,
      "note",
    );
    showToast("Empate técnico: el dictamen se mantiene en INDICIOS.");
    return;
  }

  const final = resolution.prediction;
  stampFinalVerdict(
    final,
    result.confidence,
    `Resolución del peritaje manual: ${fake} puntos de manipulación frente a ` +
      `${real} de autenticidad (los modelos aportan la señal inicial). Este ` +
      `dictamen combina las métricas con la observación directa del perito.`,
  );
  el.checklist.hidden = true;

  addLog(
    `Dictamen final del perito: ${verdictOf(final).stamp} ` +
      `(manipulación ${fake} · autenticidad ${real})`,
    final === "Fake" ? "warn" : "done",
  );

  state.history = lab().recordCase({
    name: `${state.file?.name ?? "material"} · peritaje`,
    prediction: final,
    confidence: result.confidence,
    kind: state.file?.kind ?? "image",
  });
  renderHistory();
}

export function clearChecklist(): void {
  el.checklist.hidden = true;
  el.checklistItems.replaceChildren();
  el.checklistScore.textContent = "";
  el.checklistSubmit.disabled = true;
  state.checklistAnswers = {};
}
