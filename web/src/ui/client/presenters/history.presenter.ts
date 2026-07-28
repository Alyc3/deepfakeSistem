/**
 * Interfaz — Registro de casos del equipo.
 */
import { verdictOf } from "@domain/verdict";
import { el } from "../dom";
import { state } from "../state";

export function renderHistory(): void {
  const history = state.history ?? [];
  el.historySection.hidden = history.length === 0;
  el.historyList.replaceChildren();

  for (const item of history) {
    const li = document.createElement("li");

    const name = document.createElement("span");
    name.className = "case-name";
    name.textContent = item.name;
    name.title = item.name;

    const verdict = document.createElement("span");
    verdict.className = "case-verdict";
    verdict.dataset.prediction = item.prediction;
    verdict.textContent = `${verdictOf(item.prediction).stamp} ${item.confidence}%`;

    li.append(name, verdict);
    el.historyList.appendChild(li);
  }
}
