/**
 * Dominio — Análisis.
 *
 * Forma exacta de la respuesta pericial que produce el backend
 * (`POST /predict`). El contrato vive aquí, en el núcleo, y tanto el
 * adaptador HTTP como la interfaz lo consumen: si el backend cambia, se
 * cambia en un solo sitio.
 */
import type { Prediction } from "./verdict";

/** Señal (0–1) de cada detector del ensamble. */
export interface ModelSignals {
  synthesis_gan?: number;
  faceswap_dfdc?: number;
  diffusion_modern?: number;
  /** Solo presente si la Sonda De Escena llegó a ejecutarse. */
  scene_generated?: number;
  [key: string]: number | undefined;
}

/** Segundo del video que superó el umbral de sospecha. */
export interface SuspiciousSecond {
  second: number;
  score: number;
}

/** Mapa de calor de un fotograma concreto del video. */
export interface ExplanationFrame {
  /** Data URI JPEG del fotograma con la superposición de riesgo. */
  image: string;
  /** Segundo del fotograma; `null` cuando se analizó una imagen. */
  second: number | null;
  /** Ponderación de cada detector en la fusión de ESE fotograma. */
  weights: Record<string, number>;
  width: number;
  height: number;
  /** Posición del fotograma en la secuencia analizada. */
  index: number;
  /** Señal máxima del fotograma (la que decide su color dominante). */
  signal: number;
}

/** Mapa de calor explicativo (EigenCAM fusionado) que calcula el backend. */
export interface Explanation {
  /** Data URI JPEG del fotograma destacado (el de mayor señal). */
  image: string;
  /** Segundo del fotograma destacado; `null` cuando se analizó una imagen. */
  second: number | null;
  /** Ponderación de cada detector en la fusión. */
  weights: Record<string, number>;
  width: number;
  height: number;
  /** Índice del fotograma destacado dentro de la secuencia (solo video). */
  featured_index?: number;
  /** Un mapa por cada fotograma analizado (solo video). */
  frames?: ExplanationFrame[];
}

export interface AnalysisResult {
  prediction: Prediction;
  confidence: number;
  faces_detected: number;
  models?: ModelSignals;
  caveat?: string;
  explanation?: Explanation;
  /** Solo en video. */
  frames_analyzed?: number;
  frame_scores?: number[];
  suspicious_seconds?: SuspiciousSecond[];
}

/** El material era un video (y no una imagen suelta). */
export const isVideoAnalysis = (result: AnalysisResult): boolean =>
  Boolean(result.frames_analyzed);

/** Sin rostro detectable el dictamen pierde base metodológica. */
export const lacksFace = (result: AnalysisResult): boolean =>
  result.faces_detected === 0;

/** Recorrido de detectores en el orden en que actúan en la cascada. */
export const MODEL_SEQUENCE: ReadonlyArray<keyof ModelSignals & string> = [
  "synthesis_gan",
  "faceswap_dfdc",
  "diffusion_modern",
  "scene_generated",
];

/** Rango de la señal por fotograma; `null` si el análisis no fue de video. */
export function frameSignalRange(
  result: AnalysisResult,
): { min: number; max: number } | null {
  const scores = result.frame_scores;
  if (!scores?.length) return null;
  return { min: Math.min(...scores), max: Math.max(...scores) };
}
