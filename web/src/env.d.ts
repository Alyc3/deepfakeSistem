/// <reference types="astro/client" />
declare namespace App {
  interface Locals {
    user: import("./domain/identity").IdentityUser | null;
    permissions: import("./domain/access").Permission[];
    accessToken?: string;
    client: import("./infrastructure/server/identity-service").ClientContext;
  }
  interface SessionData {
    accessToken: string;
    refreshToken: string;
    accessRenewAt: number;
    authenticatedAt: number;
    mfaToken: string;
    forensicsApiUrl: string;
  }
}
