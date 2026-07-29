/**
 * Interfaz — Estado de la sesión de trabajo.
 *
 * Lo que la pantalla necesita recordar mientras el perito trabaja. No es
 * persistencia (de eso se ocupan los repositorios), sino la foto del momento.
 */
import type { AnalysisResult } from "@domain/analysis";
import type { ChecklistAnswers } from "@domain/checklist";
import type { EvidenceFile } from "@domain/evidence";
import type { IntegrityCheck } from "@domain/integrity";
import type { CaseRecord } from "@domain/case-record";
import { ANONYMOUS_SESSION, type Session } from "@domain/analyst";
import { DEFAULT_SETTINGS, type LabSettings } from "@domain/settings";

export interface LabState {
  file: EvidenceFile | null;
  /** Huella SHA-256 del material cargado (cadena de custodia). */
  digest: string | null;
  /** Último contraste con la huella declarada en la recepción. */
  integrity: IntegrityCheck | null;
  loading: boolean;
  settings: LabSettings;
  session: Session;
  lastResult: AnalysisResult | null;
  checklistAnswers: ChecklistAnswers;
  history: CaseRecord[];
}

export const state: LabState = {
  file: null,
  digest: null,
  integrity: null,
  loading: false,
  settings: { ...DEFAULT_SETTINGS },
  session: { ...ANONYMOUS_SESSION },
  lastResult: null,
  checklistAnswers: {},
  history: [],
};
