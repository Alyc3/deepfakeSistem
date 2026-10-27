/// <reference types="astro/client" />
declare namespace App {
  interface Locals {
    user: import("./domain/identity").IdentityUser | null;
    permissions: import("./domain/access").Permission[];
    accessToken?: string;
  }
  interface SessionData {
    accessToken: string;
    authenticatedAt: number;
  }
}
