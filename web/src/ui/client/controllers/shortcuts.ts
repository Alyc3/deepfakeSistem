/**
 * Interfaz — Atajos de teclado.
 *
 * Sustituyen al menú de la aplicación de escritorio. Se evitan a propósito
 * las combinaciones que el navegador reserva (Ctrl+R recarga, Ctrl+W cierra),
 * así que "Nuevo examen" usa Alt+N.
 */
import { currentViewIsLab } from "../view-router";
import { openFilePicker, resetAll } from "./evidence.controller";
import { analyze } from "./analysis.controller";
import { handleLogout } from "./auth.controller";
import {
  heatmapHasStrip,
  heatmapIsExpanded,
  stepHeatmapFrame,
  toggleHeatmapZoom,
} from "../presenters/heatmap.presenter";

/** El foco en un campo de texto manda: las flechas mueven el cursor. */
const typingInField = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

export function wireShortcuts(): void {
  document.addEventListener("keydown", (event) => {
    // Escape cierra el mapa ampliado.
    if (event.key === "Escape") {
      if (heatmapIsExpanded()) {
        toggleHeatmapZoom(false);
        event.preventDefault();
      }
      return;
    }

    if (!currentViewIsLab()) return;

    // Flechas: recorrer los mapas de calor de los fotogramas analizados.
    if (
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      !event.ctrlKey && !event.metaKey && !event.altKey &&
      !typingInField(event.target) &&
      heatmapHasStrip()
    ) {
      if (stepHeatmapFrame(event.key === "ArrowRight" ? 1 : -1)) {
        event.preventDefault();
      }
      return;
    }

    const meta = event.ctrlKey || event.metaKey;

    if (meta && event.key.toLowerCase() === "o") {
      event.preventDefault();
      openFilePicker();
    } else if (meta && event.key === "Enter") {
      event.preventDefault();
      void analyze();
    } else if (meta && event.key === ",") {
      event.preventDefault();
      window.location.assign("/app/seguridad");
    } else if (meta && event.shiftKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      handleLogout();
    } else if (event.altKey && event.key.toLowerCase() === "n") {
      event.preventDefault();
      resetAll();
    }
  });
}
