/**
 * Interfaz — Estado de la sesión de trabajo.
 *
 * Lo que la pantalla necesita recordar mientras el perito trabaja. No es
 * persistencia (de eso se ocupan los repositorios), sino la foto del momento.
 */
import type { AnalysisResult } from "@domain/analysis";
import type { ChecklistAnswers } from "@domain/checklist";
import type { EvidenceFile } from "@domain/evidence";
import type { CaseRecord } from "@domain/case-record";
import { ANONYMOUS_SESSION, type Session } from "@domain/analyst";
import { DEFAULT_SETTINGS, type LabSettings } from "@domain/settings";

export interface LabState {
  file: EvidenceFile | null;
  loading: boolean;
  settings: LabSettings;
  session: Session;
  lastResult: AnalysisResult | null;
  checklistAnswers: ChecklistAnswers;
  history: CaseRecord[];
}

export const state: LabState = {
  file: null,
  loading: false,
  settings: { ...DEFAULT_SETTINGS },
  session: { ...ANONYMOUS_SESSION },
  lastResult: null,
  checklistAnswers: {},
  history: [],
};
