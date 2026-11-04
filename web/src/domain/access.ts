export const SECTIONS = [
  { id: "inicio", permission: "laboratory", label: "Resumen", group: "Trabajo", icon: "scan", description: "Panel principal" },
  { id: "casos", permission: "laboratory", label: "Casos y evidencias", group: "Trabajo", icon: "scan", description: "Expedientes y evidencias" },
  { id: "usuarios", permission: "users", label: "Usuarios", group: "Administración", icon: "users", description: "Cuentas y accesos del equipo" },
  { id: "roles", permission: "roles", label: "Roles y accesos", group: "Administración", icon: "shield", description: "Roles del servicio y alcance de acceso" },
  { id: "perfil", permission: "profile", label: "Mi perfil", group: "Cuenta", icon: "user", description: "Tu identidad en CertiFace" },
  { id: "seguridad", permission: "security", label: "Seguridad", group: "Cuenta", icon: "lock", description: "Sesión y recuperación de acceso" },
] as const;
export type Permission = typeof SECTIONS[number]["permission"];
export type AccessPolicy = Record<string, Permission[]>;
export const normalizeRole = (role: string) => role.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase().replace(/[\s-]+/g, "_");
export function permissionsFor(role: string, policy: AccessPolicy, fallback: Permission[] = []): Permission[] {
  return Object.entries(policy).find(([key]) => normalizeRole(key) === normalizeRole(role))?.[1] ?? fallback;
}
export const homeFor = (permissions: readonly string[]) => permissions.includes("laboratory") ? "/app/inicio" : `/app/${SECTIONS.find((section) => permissions.includes(section.permission))?.id ?? "perfil"}`;
