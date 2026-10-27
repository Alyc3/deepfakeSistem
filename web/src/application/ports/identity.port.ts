import type { IdentityUser, NewUser, Role, UserUpdate } from "@domain/identity";
export interface IdentityPort {
  login(email: string, password: string): Promise<IdentityUser>;
  profile(): Promise<IdentityUser>;
  current(): IdentityUser | null;
  hydrate(user: IdentityUser): void;
  logout(): Promise<void>;
  recoverPassword(email: string): Promise<string>;
  resetPassword(token: string, password: string): Promise<string>;
  listUsers(): Promise<IdentityUser[]>;
  createUser(data: NewUser): Promise<IdentityUser>;
  updateUser(id: string, data: UserUpdate): Promise<IdentityUser>;
  listRoles(): Promise<Role[]>;
  saveRole(data: { name: string; description?: string }, id?: string): Promise<Role>;
  deleteRole(id: string): Promise<void>;
}
