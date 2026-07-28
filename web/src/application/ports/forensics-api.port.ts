/**
 * Puerto de salida — API pericial.
 *
 * Lo que el laboratorio necesita del backend, expresado sin una sola palabra
 * de HTTP. Quien lo implemente (hoy `fetch`; mañana un mock de pruebas o un
 * canal distinto) queda fuera del núcleo.
 */
import type { AnalysisResult } from "@domain/analysis";
import type { EvidenceFile } from "@domain/evidence";

export type AnalysisOutcome =
  | { ok: true; result: AnalysisResult }
  | { ok: false; error: string };

export interface BackendStatus {
  online: boolean;
  /** URL efectiva a la que se preguntó, para mostrarla en la barra de estado. */
  endpoint: string;
  error?: string;
}

export interface ForensicsApiPort {
  /** Somete el material al ensamble de peritos y devuelve el dictamen. */
  analyze(file: EvidenceFile): Promise<AnalysisOutcome>;
  /** Comprueba si el backend responde. */
  status(): Promise<BackendStatus>;
}
