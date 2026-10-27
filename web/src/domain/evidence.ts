/**
 * Dominio — Material cuestionado.
 *
 * Reglas de admisión de la evidencia: qué formatos acepta el laboratorio y
 * hasta qué tamaño. Son las mismas que aplicaba el cliente de escritorio;
 * el navegador solo cambia de dónde salen los bytes.
 */

/** Mismo límite que el cliente de escritorio. */
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * El backend decide entre `predict_image` y `predict_video` mirando el
 * `content_type` del archivo subido (backend/app/main.py), así que el MIME
 * debe ir correcto. Se deriva de la extensión porque el navegador deja
 * `file.type` vacío en varios contenedores de video (.mkv, .avi).
 */
export const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
};

export const IMAGE_EXTENSIONS = Object.keys(MIME_TYPES).filter((ext) =>
  MIME_TYPES[ext]!.startsWith("image/"),
);
export const VIDEO_EXTENSIONS = Object.keys(MIME_TYPES).filter((ext) =>
  MIME_TYPES[ext]!.startsWith("video/"),
);

/** Filtro del selector de archivos del navegador. */
export const ACCEPT_ATTRIBUTE = Object.keys(MIME_TYPES).join(",");

export type EvidenceKind = "image" | "video";

/** Material admitido, listo para la vista previa y para el análisis. */
export interface EvidenceFile {
  expectedSha256?: string;
  name: string;
  size: number;
  mime: string;
  kind: EvidenceKind;
  /** Los bytes vivos que entregó el navegador. */
  blob: File;
}

export type EvidenceInspection =
  | { ok: true; file: EvidenceFile }
  | { ok: false; error: string };

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

export function mimeFor(name: string): string | null {
  return MIME_TYPES[extensionOf(name)] ?? null;
}

/**
 * Valida un archivo elegido por el perito: tipo soportado y tamaño.
 * Devuelve los metadatos que necesita la interfaz o el motivo del rechazo.
 */
export function inspectFile(file: File): EvidenceInspection {
  const mime = mimeFor(file.name) ?? (file.type || null);
  if (!mime || !(mime.startsWith("image/") || mime.startsWith("video/"))) {
    return { ok: false, error: "Formato no soportado. Usa una imagen o un video." };
  }

  if (file.size === 0) {
    return { ok: false, error: "El archivo está vacío o no se pudo leer." };
  }

  if (file.size > MAX_FILE_SIZE) {
    return { ok: false, error: "El archivo es demasiado grande. Máximo 10MB." };
  }

  return {
    ok: true,
    file: {
      name: file.name,
      size: file.size,
      mime,
      kind: mime.startsWith("video/") ? "video" : "image",
      blob: file,
    },
  };
}
