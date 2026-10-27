import { ServiceError } from "./identity-service";
export async function boundedBody(request: Request, limit: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ServiceError(413, "El archivo o formulario supera el tamaño permitido."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new ServiceError(415, "Formato de formulario no permitido.");
  try {
    const body = JSON.parse(new TextDecoder().decode(await boundedBody(request, 32_768)));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(400, "Formulario inválido.");
  }
}
export function serviceFailure(error: unknown): Response {
  return Response.json({ detail: error instanceof ServiceError ? error.message : "No se pudo completar la operación." }, { status: error instanceof ServiceError ? error.status : 500, headers: { "Cache-Control": "no-store" } });
}
