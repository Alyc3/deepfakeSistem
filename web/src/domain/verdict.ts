/**
 * Dominio — Dictamen.
 *
 * Vocabulario pericial del sistema: los tres estados que puede tomar un
 * dictamen y cómo se nombra cada detector ante el perito. Aquí no hay red,
 * ni DOM, ni almacenamiento: solo las reglas del negocio forense.
 */

/** Etiquetas que emite el backend (backend/app/model.py). */
export type Prediction = "Fake" | "Real" | "Suspect";

export interface VerdictPresentation {
  /** Clave de estilo (`data-verdict`) del dictamen. */
  key: "fake" | "real" | "suspect";
  /** Sello que se estampa sobre el dictamen. */
  stamp: string;
  /** Cómo se llama al porcentaje que acompaña al sello. */
  confidenceLabel: string;
}

export const VERDICTS: Record<Prediction, VerdictPresentation> = {
  Fake: { key: "fake", stamp: "MANIPULADO", confidenceLabel: "Confianza" },
  Real: { key: "real", stamp: "REAL", confidenceLabel: "Confianza" },
  // Condena sin corroboración (solo el detector de difusión): el sistema no
  // dictamina; señala y deja la decisión al perito.
  Suspect: { key: "suspect", stamp: "INDICIOS", confidenceLabel: "Señal de generación" },
};

/** Nunca falla ante una etiqueta desconocida: se degrada a "Real". */
export function verdictOf(prediction: string | undefined): VerdictPresentation {
  return VERDICTS[prediction as Prediction] ?? VERDICTS.Real;
}

/** Nombres de los detectores tal como los muestra la interfaz. */
export const MODEL_NAMES: Record<string, string> = {
  synthesis_gan: "GAN",
  faceswap_dfdc: "FACE SWAP",
  diffusion_modern: "DIFUSIÓN",
  scene_generated: "ESCENA",
};

export const pctOf = (value: number): string => `${(value * 100).toFixed(1)}%`;

/**
 * Línea "▸ DOMINANTE x% · resto…" a partir de un diccionario {clave: señal}.
 * Compartida por el desglose del dictamen y la leyenda del mapa de calor: la
 * señal que fija el dictamen va siempre primera y marcada con ▸.
 */
export function signalLegend(signals: Record<string, number>): string {
  return Object.entries(signals)
    .filter(([key]) => MODEL_NAMES[key])
    .sort((a, b) => b[1] - a[1])
    .map(([key, value], index) => `${index === 0 ? "▸ " : ""}${MODEL_NAMES[key]} ${pctOf(value)}`)
    .join(" · ");
}
