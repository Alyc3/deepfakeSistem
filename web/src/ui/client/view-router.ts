/**
 * Interfaz — Enrutador de vistas.
 *
 * Tres vistas sobre un mismo documento, igual que en el cliente de
 * escritorio: portada, acceso y laboratorio.
 */
import { el } from "./dom";

export type ViewName = "landing" | "login" | "app";

export function showView(name: ViewName): void {
  el.viewLanding.hidden = name !== "landing";
  el.viewLogin.hidden = name !== "login";
  el.viewApp.hidden = name !== "app";
  window.scrollTo(0, 0);
}

export const currentViewIsLab = (): boolean => !el.viewApp.hidden;
