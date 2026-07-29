/**
 * Interfaz — Cadena de custodia.
 *
 * Muestra la huella del material incorporado y la contrasta con la que el
 * perito anotó al recibirlo. La comprobación **advierte, no bloquea**: el
 * análisis se ejecuta igual y la discrepancia queda escrita en el registro.
 */
import { DEFAULT_ALGORITHM, shortDigest, type IntegrityCheck } from "@domain/integrity";
import { el } from "../dom";
import { state } from "../state";
import { lab } from "../lab";
import { showToast } from "../toast";

interface StatusCopy {
  chip: string;
  note: string;
}

const COPY: Record<IntegrityCheck["status"], StatusCopy> = {
  unverified: {
    chip: "SIN REFERENCIA",
    note:
      "Anota esta huella en el acta de recepción. Sin una huella de referencia " +
      "no se puede verificar que el material no haya cambiado desde entonces.",
  },
  match: {
    chip: "COINCIDE",
    note:
      "El material es bit a bit el que se recibió: la cadena de custodia se " +
      "sostiene.",
  },
  mismatch: {
    chip: "NO COINCIDE",
    note:
      "ADVERTENCIA: el material NO es el que se registró en la recepción. Pudo " +
      "recortarse, recomprimirse o sustituirse. El análisis puede continuar, " +
      "pero el dictamen se emitirá sobre material alterado y así debe constar.",
  },
  unreadable: {
    chip: "FORMATO NO RECONOCIDO",
    note:
      "La huella introducida no parece un hash hexadecimal. Se esperan 40 " +
      "dígitos (SHA-1), 64 (SHA-256), 96 (SHA-384) o 128 (SHA-512).",
  },
  unsupported: {
    chip: "MD5 NO DISPONIBLE",
    note:
      "El navegador no calcula MD5. Registra la evidencia con SHA-256, que es " +
      "el estándar forense vigente.",
  },
};

const NO_CRYPTO_NOTE =
  "La verificación de integridad necesita una conexión segura: abre el " +
  "laboratorio en https:// o en http://localhost.";

let debounce: ReturnType<typeof setTimeout> | null = null;

function paint(check: IntegrityCheck | null): void {
  state.integrity = check;

  if (!check) {
    el.custodyState.dataset.state = "unverified";
    el.custodyState.textContent = "";
    el.custodyNote.textContent = "";
    return;
  }

  const copy = COPY[check.status];
  el.custodyState.dataset.state = check.status;
  el.custodyState.textContent =
    check.status === "match" || check.status === "mismatch"
      ? `${copy.chip} · ${check.algorithm}`
      : copy.chip;
  el.custodyNote.textContent = copy.note;
}

/** Recalcula la huella y la contrasta con la declarada. */
async function verify(): Promise<IntegrityCheck | null> {
  const file = state.file;
  if (!file) return null;

  const check = await lab().verifyIntegrity(file, el.custodyExpected.value);
  paint(check);
  return check;
}

/**
 * Al incorporar material: se calcula su huella para que el perito la anote,
 * y se contrasta con lo que hubiera declarado.
 */
export async function registerEvidenceDigest(): Promise<void> {
  const file = state.file;
  if (!file) {
    el.custody.hidden = true;
    state.digest = null;
    paint(null);
    return;
  }

  el.custody.hidden = false;

  if (!lab().digestsAvailable()) {
    el.custodyDigest.textContent = "no disponible";
    el.custodyState.dataset.state = "unsupported";
    el.custodyState.textContent = "NO DISPONIBLE";
    el.custodyNote.textContent = NO_CRYPTO_NOTE;
    state.digest = null;
    state.integrity = null;
    return;
  }

  el.custodyDigest.textContent = "calculando…";
  const digest = await lab().digestEvidence(file, DEFAULT_ALGORITHM);
  if (state.file !== file) return; // el perito ya cambió de material

  state.digest = digest;
  el.custodyDigest.textContent = digest ?? "no se pudo calcular";
  await verify();
}

/**
 * Revalidación previa al análisis: la huella se vuelve a calcular sobre el
 * archivo que se va a examinar, no se reutiliza la anterior.
 */
export async function verifyBeforeAnalysis(): Promise<IntegrityCheck | null> {
  if (!state.file || !lab().digestsAvailable()) return null;
  const check = await verify();
  if (check?.computed) {
    state.digest = check.algorithm === DEFAULT_ALGORITHM ? check.computed : state.digest;
  }
  return check;
}

export function clearCustody(): void {
  el.custody.hidden = true;
  el.custodyDigest.textContent = "calculando…";
  el.custodyExpected.value = "";
  state.digest = null;
  paint(null);
}

async function copyDigest(): Promise<void> {
  const digest = state.digest;
  if (!digest) return;
  try {
    await navigator.clipboard.writeText(digest);
    showToast("Huella copiada al portapapeles.");
  } catch {
    // El portapapeles puede estar vetado por permisos: se selecciona para
    // que el perito la copie a mano.
    const range = document.createRange();
    range.selectNodeContents(el.custodyDigest);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    showToast("Selecciona y copia la huella con el teclado.");
  }
}

export function wireCustody(): void {
  el.custodyCopy.addEventListener("click", () => void copyDigest());

  el.custodyExpected.addEventListener("input", () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void verify(), 250);
  });

  el.custodyExpected.addEventListener("change", () => void verify());
}

/** Texto de bitácora para el registro del análisis. */
export function integrityLogLine(check: IntegrityCheck | null): {
  text: string;
  status: "done" | "warn" | "note";
} {
  if (!check) {
    return {
      text: "Integridad no verificada: el navegador no ofrece criptografía en esta conexión",
      status: "note",
    };
  }

  const digest = check.computed ? shortDigest(check.computed) : "no calculada";

  switch (check.status) {
    case "match":
      return {
        text: `Integridad verificada (${check.algorithm} ${digest}): coincide con la huella de recepción`,
        status: "done",
      };
    case "mismatch":
      return {
        text:
          `ADVERTENCIA — la huella ${check.algorithm} del material (${digest}) NO coincide ` +
          `con la registrada en la recepción: el material fue alterado. El análisis continúa`,
        status: "warn",
      };
    case "unsupported":
      return {
        text: `Huella ${check.algorithm} del material: ${digest} (la referencia es MD5, no verificable aquí)`,
        status: "note",
      };
    case "unreadable":
      return {
        text: `Huella ${check.algorithm} del material: ${digest} (la referencia introducida no es un hash válido)`,
        status: "note",
      };
    default:
      return {
        text: `Huella ${check.algorithm} del material: ${digest} (sin referencia de recepción: integridad no verificada)`,
        status: "note",
      };
  }
}
