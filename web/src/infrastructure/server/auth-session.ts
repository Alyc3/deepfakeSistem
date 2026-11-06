import { createHash } from "node:crypto";
import type { AstroSession } from "astro";
import { identityRequest, ServiceError, type ClientContext } from "./identity-service";
import { serverConfig } from "./config";

export interface TokenPair { access_token: string; refresh_token: string; token_type: string; expires_in: number; refresh_expires_in: number; }
export interface MfaChallenge { mfa_required: true; mfa_token: string; }

const MFA_TTL_SECONDS = 300;

export function isTokenPair(value: unknown): value is TokenPair {
  const pair = value as TokenPair | null;
  return !!pair && typeof pair.access_token === "string" && typeof pair.refresh_token === "string"
    && pair.token_type?.toLowerCase() === "bearer" && Number.isFinite(pair.expires_in) && pair.expires_in > 0;
}
export function isMfaChallenge(value: unknown): value is MfaChallenge {
  const challenge = value as MfaChallenge | null;
  return !!challenge && challenge.mfa_required === true && typeof challenge.mfa_token === "string";
}

/**
 * Momento en que conviene renovar: un poco antes de que caduque, para que una petición larga no empiece
 * con un token a punto de vencer. El margen es un cuarto de la vida del token, como mucho 60 s.
 */
const renewAt = (issuedAt: number, pair: TokenPair) => {
  const lifetime = pair.expires_in * 1000;
  return issuedAt + lifetime - Math.min(60_000, lifetime / 4);
};
function remaining(authenticatedAt: number): number {
  return Math.max(1, Math.floor((authenticatedAt + serverConfig().sessionTtlSeconds * 1000 - Date.now()) / 1000));
}
function storeTokens(session: AstroSession, pair: TokenPair, issuedAt: number, authenticatedAt: number): void {
  const ttl = remaining(authenticatedAt);
  session.set("accessToken", pair.access_token, { ttl });
  session.set("refreshToken", pair.refresh_token, { ttl });
  session.set("accessRenewAt", renewAt(issuedAt, pair), { ttl });
}

/** Abre una sesión nueva (id regenerado contra la fijación de sesión) con los tokens del login. */
export async function establishSession(session: AstroSession, pair: TokenPair): Promise<void> {
  await session.regenerate();
  const authenticatedAt = Date.now();
  session.set("authenticatedAt", authenticatedAt, { ttl: serverConfig().sessionTtlSeconds });
  storeTokens(session, pair, authenticatedAt, authenticatedAt);
}

/** Guarda el reto MFA en el servidor: el mfa_token nunca llega al navegador. */
export async function storeMfaChallenge(session: AstroSession, challenge: MfaChallenge): Promise<void> {
  await session.regenerate();
  session.set("mfaToken", challenge.mfa_token, { ttl: MFA_TTL_SECONDS });
}

/*
 * El auth-service rota el refresh token en cada uso y, si recibe uno ya usado, revoca la sesión por
 * posible robo. Varias peticiones simultáneas del mismo navegador podrían renovar con el mismo token,
 * así que comparten una única renovación: la primera la hace y las demás reutilizan su resultado.
 * Si una petición llega con un refresh token antiguo, se sigue la cadena de rotaciones hasta el par
 * vigente en lugar de reenviar al auth-service un token ya usado.
 * La caché vive en memoria: con varias réplicas, usa afinidad de sesión (sticky sessions).
 */
interface Rotation { result: Promise<{ pair: TokenPair; issuedAt: number }>; expires: number; }
const rotations = new Map<string, Rotation>();
const CHAIN_TTL_MS = 10 * 60_000;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

async function rotate(refreshToken: string, client: ClientContext, depth = 0): Promise<{ pair: TokenPair; issuedAt: number }> {
  const now = Date.now();
  for (const [key, entry] of rotations) if (entry.expires < now) rotations.delete(key);
  const key = digest(refreshToken);
  const cached = rotations.get(key);
  if (cached) {
    const done = await cached.result;
    // El par cacheado sigue sirviendo, o ya toca renovarlo: se continúa desde su refresh token.
    if (renewAt(done.issuedAt, done.pair) > Date.now() || depth >= 20) return done;
    return rotate(done.pair.refresh_token, client, depth + 1);
  }
  const result = identityRequest("/api/auth/refresh", { method: "POST", body: { refresh_token: refreshToken }, client })
    .then((pair) => {
      if (!isTokenPair(pair)) throw new ServiceError(502, "El servicio no devolvió una sesión válida.");
      return { pair, issuedAt: Date.now() };
    });
  rotations.set(key, { result, expires: now + CHAIN_TTL_MS });
  // Un fallo de red no consumió el token: se permite reintentar. Un 401 significa que la sesión terminó.
  result.catch((error) => { if (!(error instanceof ServiceError) || error.status !== 401) rotations.delete(key); });
  return result;
}

/**
 * Access token vigente de la sesión. Lo renueva si está por caducar o si `force` es true
 * (el auth-service lo rechazó). Devuelve null si la sesión terminó.
 */
export async function accessToken(session: AstroSession, client: ClientContext, force = false): Promise<string | null> {
  const [token, refreshToken, renewAtTime, authenticatedAt] = await Promise.all([
    session.get("accessToken"), session.get("refreshToken"), session.get("accessRenewAt"), session.get("authenticatedAt"),
  ]);
  if (!token || !authenticatedAt) return null;
  if (!force && renewAtTime && renewAtTime > Date.now()) return token;
  if (!refreshToken) return force ? null : token;
  try {
    let { pair, issuedAt } = await rotate(refreshToken, client);
    // El auth-service rechazó justo el token de la caché (p. ej. caducó antes por desfase de reloj):
    // se renueva una vez más desde su refresh token. Si vuelve el mismo, la sesión ya no es válida.
    if (force && pair.access_token === token) ({ pair, issuedAt } = await rotate(pair.refresh_token, client));
    if (force && pair.access_token === token) return null;
    storeTokens(session, pair, issuedAt, authenticatedAt);
    return pair.access_token;
  } catch (error) {
    if (error instanceof ServiceError && [400, 401, 422].includes(error.status)) return null;
    throw error;
  }
}

export function clearSession(session: AstroSession | undefined): void {
  session?.destroy();
}
