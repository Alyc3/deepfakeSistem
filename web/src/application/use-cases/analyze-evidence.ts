/**
 * Caso de uso — Someter el material al ensamble pericial.
 *
 * El caso de uso no sabe que hay HTTP detrás: recibe el puerto y lo usa.
 */
import type { EvidenceFile } from "@domain/evidence";
import type { AnalysisOutcome, ForensicsApiPort } from "@application/ports/forensics-api.port";

export const analyzeEvidence =
  (api: ForensicsApiPort) =>
  (file: EvidenceFile): Promise<AnalysisOutcome> =>
    api.analyze(file);
