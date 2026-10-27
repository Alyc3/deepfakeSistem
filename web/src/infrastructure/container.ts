/**
 * RaÃ­z de composiciÃ³n.
 *
 * Ãšnico punto donde se enchufan adaptadores concretos en los puertos. La
 * interfaz solo conoce este objeto de casos de uso: cambiar `fetch` por otro
 * transporte, o `localStorage` por IndexedDB, se hace aquÃ­ y en ningÃºn otro
 * sitio.
 */
import { analyzeEvidence, finalizeReport } from "@application/use-cases/analyze-evidence";
import { checkBackendStatus } from "@application/use-cases/check-backend-status";
import { selectEvidence } from "@application/use-cases/select-evidence";
import {
  loginAnalyst,
  logoutAnalyst,
  sessionStatus,
} from "@application/use-cases/manage-session";
import { clearCases, listCases, recordCase } from "@application/use-cases/manage-cases";
import { readSettings, saveApiUrl } from "@application/use-cases/manage-settings";
import { resolveIndications, scoreIndications } from "@application/use-cases/resolve-indications";
import {
  digestEvidence,
  digestsAvailable,
  verifyIntegrity,
} from "@application/use-cases/verify-integrity";

import { createHttpForensicsApi } from "./http/http-forensics-api";
import { createLocalSettingsRepository } from "./storage/local-settings.repository";
import { createLocalCaseRepository } from "./storage/local-case.repository";
import { createHttpIdentity } from "./http/http-identity";
import { createWebCryptoDigest } from "./crypto/web-crypto-digest";

export function createLab() {
  const settings = createLocalSettingsRepository();
  const identity = createHttpIdentity();
  const cases = createLocalCaseRepository(() => identity.current()?.id ?? null);
  const digests = createWebCryptoDigest();

  // La API relee la URL en cada llamada: si el perito la cambia en el panel
  // de configuraciÃ³n, la siguiente peticiÃ³n ya sale a la nueva.
  const api = createHttpForensicsApi(() => "/api/forensics", () => identity.current() !== null);


  return {
    identity,
    analyzeEvidence: analyzeEvidence(api),
    finalizeReport: finalizeReport(api),
    checkBackendStatus: checkBackendStatus(api),
    selectEvidence: selectEvidence(),

    digestEvidence: digestEvidence(digests),
    verifyIntegrity: verifyIntegrity(digests),
    digestsAvailable: digestsAvailable(digests),

    sessionStatus: sessionStatus(identity),
    loginAnalyst: loginAnalyst(identity),
    logoutAnalyst: logoutAnalyst(identity),

    listCases: listCases(cases),
    recordCase: recordCase(cases),
    clearCases: clearCases(cases),

    readSettings: readSettings(settings),
    saveApiUrl: saveApiUrl(settings),

    scoreIndications: scoreIndications(),
    resolveIndications: resolveIndications(),
  };
}

export type Lab = ReturnType<typeof createLab>;
