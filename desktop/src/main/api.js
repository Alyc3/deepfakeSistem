const fs = require("node:fs/promises");
const path = require("node:path");

// Mismo límite que usaba el frontend web.
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// El backend decide entre predict_image y predict_video mirando el content_type
// del archivo subido (backend/app/main.py), así que el MIME debe ir correcto.
const MIME_TYPES = {
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

const IMAGE_EXTENSIONS = Object.keys(MIME_TYPES).filter((ext) =>
  MIME_TYPES[ext].startsWith("image/")
);
const VIDEO_EXTENSIONS = Object.keys(MIME_TYPES).filter((ext) =>
  MIME_TYPES[ext].startsWith("video/")
);

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || null;
}

/**
 * Valida un archivo del disco antes de enviarlo: tipo soportado y tamaño.
 * Devuelve los metadatos que necesita el renderer para la vista previa.
 */
async function inspectFile(filePath) {
  const mime = mimeFor(filePath);
  if (!mime) {
    return { ok: false, error: "Formato no soportado. Usa una imagen o un video." };
  }

  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch {
    return { ok: false, error: "No se pudo leer el archivo." };
  }

  if (!stats.isFile()) {
    return { ok: false, error: "La ruta seleccionada no es un archivo." };
  }

  if (stats.size > MAX_FILE_SIZE) {
    return { ok: false, error: "El archivo es demasiado grande. Máximo 10MB." };
  }

  return {
    ok: true,
    file: {
      path: filePath,
      name: path.basename(filePath),
      size: stats.size,
      mime,
      kind: mime.startsWith("video/") ? "video" : "image",
    },
  };
}

function normalizeBaseUrl(apiUrl) {
  return String(apiUrl || "").replace(/\/+$/, "");
}

/**
 * Comprueba el endpoint de salud del backend (GET /).
 * Render apaga el servicio gratuito por inactividad, así que un timeout
 * largo aquí no significa que el backend esté caído, sino despertando.
 */
async function checkHealth(apiUrl, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalizeBaseUrl(apiUrl)}/`, {
      signal: controller.signal,
    });
    if (!response.ok) return { online: false, error: `HTTP ${response.status}` };
    const data = await response.json();
    return { online: data?.status === "ok" };
  } catch (err) {
    return { online: false, error: err.name === "AbortError" ? "timeout" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Envía el archivo a POST /predict como multipart/form-data.
 * La petición sale del proceso principal (no del renderer) para no depender
 * de CORS ni de la política de contenido de la ventana.
 */
async function predict(apiUrl, filePath, timeoutMs = 180000) {
  const inspection = await inspectFile(filePath);
  if (!inspection.ok) {
    return { ok: false, error: inspection.error };
  }

  const { name, mime, kind } = inspection.file;
  const buffer = await fs.readFile(filePath);
  console.log(
    `[CertiFace] Enviando ${kind} "${name}" (${mime}, ${(buffer.length / 1024).toFixed(0)} KB) a ${normalizeBaseUrl(apiUrl)}/predict`
  );

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mime }), name);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const response = await fetch(`${normalizeBaseUrl(apiUrl)}/predict`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[CertiFace] HTTP ${response.status} en ${elapsed}s: ${body}`);
      // Los errores 4xx del backend traen un "detail" con la causa concreta.
      let detail = "";
      try {
        detail = JSON.parse(body)?.detail || "";
      } catch {}
      return {
        ok: false,
        error: detail || `El servidor devolvió un error (HTTP ${response.status}). Intenta de nuevo.`,
      };
    }

    const result = await response.json();
    console.log(`[CertiFace] Respuesta en ${elapsed}s:`, JSON.stringify(result));
    return { ok: true, result };
  } catch (err) {
    if (err.name === "AbortError") {
      console.error(`[CertiFace] Análisis cancelado por tiempo (${timeoutMs / 1000}s)`);
      return { ok: false, error: "El análisis tardó demasiado y se canceló." };
    }
    console.error(`[CertiFace] Fallo de conexión: ${err.message}`);
    return {
      ok: false,
      error: `No se pudo conectar con el backend en ${normalizeBaseUrl(apiUrl)}. ¿Está en marcha?`,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  inspectFile,
  mimeFor,
  predict,
  checkHealth,
  MAX_FILE_SIZE,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
};
