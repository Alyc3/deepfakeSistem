export interface Role { id: string; name: string; description?: string | null; }
export const USER_STATUSES = ["ACTIVO", "INACTIVO", "SUSPENDIDO", "PENDIENTE"] as const;
export type UserStatus = typeof USER_STATUSES[number];
/** Una cuenta nueva nace activa o pendiente; inactivar y suspender son acciones sobre cuentas que ya existen. */
export const NEW_USER_STATUSES = ["ACTIVO", "PENDIENTE"] as const satisfies readonly UserStatus[];
export interface IdentityUser {
  id: string; email: string; role: Role; status: UserStatus;
  first_name?: string | null; last_name?: string | null;
  identifier?: string | null; phone_number?: string | null;
  email_verified?: boolean; mfa_enabled?: boolean;
  suspended_from?: string | null; suspended_until?: string | null;
  locked_until?: string | null; last_login_at?: string | null; created_at?: string | null;
}
/** Alta de usuario. Sin contraseña, el auth-service envía una invitación por correo. */
export interface NewUser {
  email: string; password?: string; role_name: string;
  first_name?: string; last_name?: string; identifier?: string;
  phone_number?: string; status?: UserStatus;
}
export type UserUpdate = Partial<Pick<NewUser, "email" | "password" | "role_name" | "first_name" | "last_name" | "identifier" | "phone_number" | "status">>;
export type ProfileUpdate = Partial<Pick<IdentityUser, "first_name" | "last_name" | "phone_number">>;
export interface AccountSession {
  id: string; user_agent?: string | null; ip_address?: string | null;
  created_at: string; last_used_at: string; expires_at: string; current: boolean;
}
export interface MfaSetup { secret: string; otpauth_uri: string; qr_svg: string; }
export interface AuditEntry {
  id: string; user_id?: string | null; action: string; endpoint?: string | null;
  ip_address?: string | null; user_agent?: string | null; details?: string | null; created_at: string;
}
export interface AuditPage { items: AuditEntry[]; total: number; }
export interface AuditFilter { action?: string; user_id?: string; date_from?: string; date_to?: string; skip?: number; limit?: number; }
export type LoginOutcome = { user: IdentityUser; mfaRequired?: false } | { user?: undefined; mfaRequired: true };

export const fullName = (user: Pick<IdentityUser, "first_name" | "last_name" | "email">) =>
  [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email;
/** Una cuenta está bloqueada por intentos fallidos mientras locked_until sea futuro. */
export const isLocked = (user: IdentityUser, now = Date.now()) => !!user.locked_until && Date.parse(user.locked_until) > now;
export const isSuspended = (user: IdentityUser, now = Date.now()) =>
  !!user.suspended_from && !!user.suspended_until && Date.parse(user.suspended_from) <= now && now <= Date.parse(user.suspended_until);

/** Error del servicio de identidad. `errors` trae los incumplimientos de la política de contraseñas. */
export class IdentityError extends Error {
  constructor(message: string, public status: number, public errors: string[] = []) { super(message); }
}
