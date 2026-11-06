/**
 * Raíz de composición.
 *
 * Único punto donde se enchufan adaptadores concretos en los puertos. La
 * interfaz solo conoce este objeto de casos de uso: cambiar `fetch` por otro
 * transporte, o `localStorage` por IndexedDB, se hace aquí y en ningún otro
 * sitio.
 */
import { analyzeEvidence, finalizeReport } from "@application/use-cases/analyze-evidence";
import { checkBackendStatus } from "@application/use-cases/check-backend-status";
import { selectEvidence } from "@application/use-cases/select-evidence";
import {
  loginAnalyst,
  logoutAnalyst,
  sessionStatus,
  verifyAnalystMfa,
} from "@application/use-cases/manage-session";
import { clearCases, listCases, recordCase } from "@application/use-cases/manage-cases";
import { resolveIndications, scoreIndications } from "@application/use-cases/resolve-indications";
import {
  digestEvidence,
  digestsAvailable,
  verifyIntegrity,
} from "@application/use-cases/verify-integrity";

import { createHttpForensicsApi } from "./http/http-forensics-api";
import { createLocalCaseRepository } from "./storage/local-case.repository";
import { createHttpIdentity } from "./http/http-identity";
import { createWebCryptoDigest } from "./crypto/web-crypto-digest";

export function createLab() {
  const identity = createHttpIdentity();
  const cases = createLocalCaseRepository(() => identity.current()?.id ?? null);
  const digests = createWebCryptoDigest();

  // El navegador solo habla con el servidor web (/api/forensics); este decide a qué motor llamar.
  const api = createHttpForensicsApi(() => identity.current() !== null);

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
    verifyAnalystMfa: verifyAnalystMfa(identity),
    logoutAnalyst: logoutAnalyst(identity),

    listCases: listCases(cases),
    recordCase: recordCase(cases),
    clearCases: clearCases(cases),

    scoreIndications: scoreIndications(),
    resolveIndications: resolveIndications(),
  };
}

export type Lab = ReturnType<typeof createLab>;
