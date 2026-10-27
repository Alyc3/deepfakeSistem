/** Las secciones internas son rutas protegidas en el servidor. */
export type ViewName = "landing" | "login" | "app";
export function showView(name: ViewName): void { window.location.assign(name === "landing" ? "/" : name === "login" ? "/login" : "/app"); }
export const currentViewIsLab = (): boolean => document.body.dataset.section === "laboratorio";
