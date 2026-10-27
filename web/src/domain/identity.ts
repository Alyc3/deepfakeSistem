export interface Role { id: string; name: string; description?: string | null; }
export const USER_STATUSES = ["ACTIVO", "INACTIVO", "SUSPENDIDO", "PENDIENTE"] as const;
export type UserStatus = typeof USER_STATUSES[number];
export interface IdentityUser {
  id: string; email: string; role: Role; status: UserStatus;
  first_name?: string | null; last_name?: string | null;
  identifier?: string | null; phone_number?: string | null;
}
export interface NewUser {
  email: string; password: string; role_name: string;
  first_name?: string; last_name?: string; identifier?: string;
  phone_number?: string; status?: UserStatus;
}
export type UserUpdate = Partial<Pick<NewUser, "email" | "password" | "role_name" | "identifier" | "phone_number" | "status">>;
