/**
 * Raíz de composición.
 *
 * Único punto donde se enchufan adaptadores concretos en los puertos. La
 * interfaz solo conoce este objeto de casos de uso: cambiar `fetch` por otro
 * transporte, o `localStorage` por IndexedDB, se hace aquí y en ningún otro
 * sitio.
 */
import { analyzeEvidence } from "@application/use-cases/analyze-evidence";
import { checkBackendStatus } from "@application/use-cases/check-backend-status";
import { selectEvidence } from "@application/use-cases/select-evidence";
import {
  loginAnalyst,
  logoutAnalyst,
  registerAnalyst,
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
import { createLocalCredentialRepository } from "./storage/local-credential.repository";
import { createWebCryptoHasher } from "./crypto/web-crypto-hasher";
import { createWebCryptoDigest } from "./crypto/web-crypto-digest";

export function createLab() {
  const settings = createLocalSettingsRepository();
  const cases = createLocalCaseRepository();
  const credentials = createLocalCredentialRepository();
  const hasher = createWebCryptoHasher();
  const digests = createWebCryptoDigest();

  // La API relee la URL en cada llamada: si el perito la cambia en el panel
  // de configuración, la siguiente petición ya sale a la nueva.
  const api = createHttpForensicsApi(() => settings.read().apiUrl);

  const auth = { credentials, hasher };

  return {
    analyzeEvidence: analyzeEvidence(api),
    checkBackendStatus: checkBackendStatus(api),
    selectEvidence: selectEvidence(),

    digestEvidence: digestEvidence(digests),
    verifyIntegrity: verifyIntegrity(digests),
    digestsAvailable: digestsAvailable(digests),

    sessionStatus: sessionStatus(auth),
    registerAnalyst: registerAnalyst(auth),
    loginAnalyst: loginAnalyst(auth),
    logoutAnalyst: logoutAnalyst(auth),

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
