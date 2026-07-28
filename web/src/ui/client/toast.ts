/** Interfaz — Aviso efímero al pie de la pantalla. */
import { el } from "./dom";

let timer: ReturnType<typeof setTimeout> | null = null;

export function showToast(message: string): void {
  el.toast.textContent = message;
  el.toast.hidden = false;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    el.toast.hidden = true;
  }, 3500);
}
