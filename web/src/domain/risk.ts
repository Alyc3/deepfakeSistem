/**
 * Dominio — Escala de riesgo.
 *
 * La misma escala con la que el backend colorea el mapa de calor
 * (verde → amarillo → naranja → rojo por intensidad absoluta), expresada en
 * bandas para poder etiquetar cifras en la interfaz con el mismo lenguaje
 * que la imagen. Si la lectura de un fotograma dice 62 %, su etiqueta sale
 * naranja igual que su mancha.
 */

export type RiskBand = "green" | "yellow" | "orange" | "red";

export const RISK_LABELS: Record<RiskBand, string> = {
  green: "riesgo bajo",
  yellow: "riesgo medio",
  orange: "riesgo alto",
  red: "riesgo muy alto",
};

export function riskBand(signal: number): RiskBand {
  if (signal >= 0.75) return "red";
  if (signal >= 0.5) return "orange";
  if (signal >= 0.25) return "yellow";
  return "green";
}

/** Clase CSS que colorea una cifra con su banda de riesgo. */
export const riskClass = (signal: number): string => `risk-${riskBand(signal)}`;
