/**
 * Caso de uso — Admitir material en la cámara de evidencia.
 *
 * No toca red ni disco: aplica las reglas de admisión del dominio al archivo
 * que entregó el navegador (selector, arrastre o muestra de demostración).
 */
import { inspectFile, type EvidenceInspection } from "@domain/evidence";

export const selectEvidence = () => (file: File): EvidenceInspection =>
  inspectFile(file);
