import type { IdentityPort } from "@application/ports/identity.port";
import { IdentityError, type IdentityUser } from "@domain/identity";

// Rutas donde un 401 es una respuesta esperada (credenciales o código incorrectos), no una sesión caducada.
const ANONYMOUS = ["/auth/login", "/auth/mfa/verify", "/auth/password-recovery", "/auth/reset-password"];

export function createHttpIdentity(): IdentityPort {
  let user: IdentityUser | null = null;
  async function request(path: string, method = "GET", body?: unknown): Promise<any> {
    let response: Response;
    try {
      response = await fetch(`/api/identity${path}`, { method, credentials: "same-origin", cache: "no-store",
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(130_000),
      });
    } catch { throw new Error("No se pudo conectar. Intenta de nuevo."); }
    if (!response.ok) {
      if (response.status === 401 && !ANONYMOUS.includes(path)) {
        user = null;
        window.dispatchEvent(new Event("certiface:session-expired"));
      }
      const data = await response.json().catch(() => ({}));
      const errors = Array.isArray(data.errors) ? data.errors.filter((item: unknown) => typeof item === "string") : [];
      throw new IdentityError(typeof data.detail === "string" ? data.detail : "No se pudo completar la operación.", response.status, errors);
    }
    return response.status === 204 ? undefined : response.json();
  }
  const id = (value: string) => encodeURIComponent(value);
  return {
    async login(email, password) {
      const result = await request("/auth/login", "POST", { email, password });
      if (result?.mfa_required) return { mfaRequired: true };
      user = result.user; return { user: user! };
    },
    async verifyMfa(code) { const result = await request("/auth/mfa/verify", "POST", { code }); user = result.user; return user!; },
    async profile() { const result = await request("/auth/me"); user = result.user; return user!; },
    hydrate: (profile) => { user = profile; },
    current: () => user,
    async logout() { await request("/auth/logout", "POST"); user = null; },
    async logoutAll() { await request("/auth/logout-all", "POST"); user = null; },
    recoverPassword: async (email) => (await request("/auth/password-recovery", "POST", { email })).message,
    resetPassword: async (token, password) => (await request("/auth/reset-password", "POST", { token, new_password: password })).message,
    async updateProfile(data) { user = await request("/auth/me", "PATCH", data); return user!; },
    changePassword: async (current_password, new_password) => (await request("/auth/change-password", "POST", { current_password, new_password })).message,
    listSessions: () => request("/auth/sessions"),
    revokeSession: (sessionId) => request(`/auth/sessions/${id(sessionId)}`, "DELETE"),
    setupMfa: (password) => request("/auth/mfa/setup", "POST", { password }),
    enableMfa: async (code) => (await request("/auth/mfa/enable", "POST", { code })).message,
    disableMfa: async (password, code) => (await request("/auth/mfa/disable", "POST", { password, code })).message,
    listUsers: () => request("/users"),
    createUser: (data) => request("/users", "POST", data),
    updateUser: (userId, data) => request(`/users/${id(userId)}`, "PATCH", data),
    deleteUser: (userId) => request(`/users/${id(userId)}`, "DELETE"),
    suspendUser: (userId, suspended_from, suspended_until) => request(`/users/${id(userId)}/suspend`, "PATCH", { suspended_from, suspended_until }),
    unlockUser: (userId) => request(`/users/${id(userId)}/unlock`, "POST"),
    revokeUserSessions: (userId) => request(`/users/${id(userId)}/revoke-sessions`, "POST"),
    resetUserMfa: (userId) => request(`/users/${id(userId)}/mfa`, "DELETE"),
    listRoles: () => request("/roles"),
    saveRole: (data, roleId) => request(roleId ? `/roles/${id(roleId)}` : "/roles", roleId ? "PUT" : "POST", data),
    deleteRole: (roleId) => request(`/roles/${id(roleId)}`, "DELETE"),
    listAudit: (filter) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") query.set(key, String(value));
      return request(`/audit${query.size ? `?${query}` : ""}`);
    },
  };
}
