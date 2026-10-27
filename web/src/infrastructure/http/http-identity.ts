import type { IdentityPort } from "@application/ports/identity.port";
import type { IdentityUser } from "@domain/identity";
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
      if (response.status === 401) {
        user = null;
        if (path !== "/auth/login") window.dispatchEvent(new Event("certiface:session-expired"));
      }
      const data = await response.json().catch(() => ({}));
      throw new Error(typeof data.detail === "string" ? data.detail : "No se pudo completar la operación.");
    }
    return response.status === 204 ? undefined : response.json();
  }
  return {
    async login(email, password) { const result = await request("/auth/login", "POST", { email, password }); user = result.user; return user!; },
    async profile() { const result = await request("/auth/me"); user = result.user; return user!; },
    hydrate: (profile) => { user = profile; },
    current: () => user,
    async logout() { await request("/auth/logout", "POST"); user = null; },
    recoverPassword: async (email) => (await request("/auth/password-recovery", "POST", { email })).message,
    resetPassword: async (token, password) => (await request("/auth/reset-password", "POST", { token, new_password: password })).message,
    listUsers: () => request("/users"),
    createUser: (data) => request("/users", "POST", data),
    updateUser: (id, data) => request(`/users/${encodeURIComponent(id)}`, "PATCH", data),
    listRoles: () => request("/roles"),
    saveRole: (data, id) => request(id ? `/roles/${encodeURIComponent(id)}` : "/roles", id ? "PUT" : "POST", data),
    deleteRole: (id) => request(`/roles/${encodeURIComponent(id)}`, "DELETE"),
  };
}
