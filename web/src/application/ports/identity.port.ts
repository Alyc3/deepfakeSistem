import type {
  AccountSession, AuditFilter, AuditPage, IdentityUser, LoginOutcome, MfaSetup, NewUser, ProfileUpdate, Role, UserUpdate,
} from "@domain/identity";
export interface IdentityPort {
  login(email: string, password: string): Promise<LoginOutcome>;
  verifyMfa(code: string): Promise<IdentityUser>;
  profile(): Promise<IdentityUser>;
  current(): IdentityUser | null;
  hydrate(user: IdentityUser): void;
  logout(): Promise<void>;
  logoutAll(): Promise<void>;
  recoverPassword(email: string): Promise<string>;
  resetPassword(token: string, password: string): Promise<string>;
  // Cuenta propia
  updateProfile(data: ProfileUpdate): Promise<IdentityUser>;
  changePassword(currentPassword: string, newPassword: string): Promise<string>;
  listSessions(): Promise<AccountSession[]>;
  revokeSession(id: string): Promise<void>;
  setupMfa(password: string): Promise<MfaSetup>;
  enableMfa(code: string): Promise<string>;
  disableMfa(password: string, code: string): Promise<string>;
  // Administración
  listUsers(): Promise<IdentityUser[]>;
  createUser(data: NewUser): Promise<IdentityUser>;
  updateUser(id: string, data: UserUpdate): Promise<IdentityUser>;
  deleteUser(id: string): Promise<void>;
  suspendUser(id: string, from: string | null, until: string | null): Promise<IdentityUser>;
  unlockUser(id: string): Promise<IdentityUser>;
  revokeUserSessions(id: string): Promise<void>;
  resetUserMfa(id: string): Promise<IdentityUser>;
  listRoles(): Promise<Role[]>;
  saveRole(data: { name: string; description?: string }, id?: string): Promise<Role>;
  deleteRole(id: string): Promise<void>;
  listAudit(filter: AuditFilter): Promise<AuditPage>;
}
