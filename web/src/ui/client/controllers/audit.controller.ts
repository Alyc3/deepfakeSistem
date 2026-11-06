import { fullName, type AuditEntry, type AuditFilter } from "@domain/identity";
import { lab } from "../lab";
import { describeError } from "../errors";

const PAGE = 50;
const node = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const dateTime = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "medium" });
let skip = 0;
let filter: AuditFilter = {};
let names = new Map<string, string>();
let generation = 0;

function cell(content: string, className = ""): HTMLTableCellElement {
  const td = document.createElement("td"); td.textContent = content; td.className = className; return td;
}
/** Los detalles llegan como JSON en texto; se muestran como pares clave: valor legibles. */
function details(raw?: string | null): string {
  if (!raw) return "—";
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(data).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(" · ") || "—";
  } catch { return raw; }
}
function row(entry: AuditEntry): HTMLTableRowElement {
  const tr = document.createElement("tr");
  const when = cell(dateTime.format(new Date(entry.created_at)), "mono-value"); when.dataset.label = "Fecha";
  const action = document.createElement("td"); action.dataset.label = "Acción";
  const badge = document.createElement("span"); badge.className = `badge ${/failed|reuse|locked|deleted|suspended$|revoked|reset$/.test(entry.action) ? "badge-alert" : "badge-muted"}`; badge.textContent = entry.action;
  action.append(badge);
  const who = cell(entry.user_id ? names.get(entry.user_id) ?? entry.user_id : "—"); who.dataset.label = "Usuario";
  const origin = cell([entry.ip_address, entry.endpoint].filter(Boolean).join(" · ") || "—", "mono-value"); origin.dataset.label = "Origen";
  const info = cell(details(entry.details), "audit-details"); info.dataset.label = "Detalles";
  if (entry.user_agent) info.title = entry.user_agent;
  tr.append(when, action, who, origin, info);
  return tr;
}
async function load(): Promise<void> {
  const request = ++generation;
  const message = node("audit-message"); message.textContent = "Cargando eventos…";
  node<HTMLButtonElement>("audit-prev").disabled = true; node<HTMLButtonElement>("audit-next").disabled = true;
  try {
    const page = await lab().identity.listAudit({ ...filter, skip, limit: PAGE });
    if (request !== generation) return;
    node("audit-rows").replaceChildren(...page.items.map(row));
    node("audit-empty").hidden = page.items.length > 0;
    node("audit-count").textContent = page.total ? `${skip + 1}–${skip + page.items.length} de ${page.total} eventos` : "";
    node<HTMLButtonElement>("audit-prev").disabled = skip === 0;
    node<HTMLButtonElement>("audit-next").disabled = skip + page.items.length >= page.total;
    message.textContent = "";
  } catch (error) { message.textContent = describeError(error, "No se pudo cargar la auditoría."); }
}
export function wireAudit(canListUsers: boolean): void {
  const form = node<HTMLFormElement>("audit-filter");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const day = (key: string, end: boolean) => {
      const value = String(data.get(key) ?? "");
      // Los días se interpretan en la hora local y se envían en UTC.
      return value ? new Date(`${value}T${end ? "23:59:59.999" : "00:00:00"}`).toISOString() : undefined;
    };
    filter = { action: String(data.get("action") ?? "").trim() || undefined, date_from: day("date_from", false), date_to: day("date_to", true) };
    skip = 0; void load();
  });
  node("audit-refresh").addEventListener("click", () => void load());
  node("audit-prev").addEventListener("click", () => { skip = Math.max(0, skip - PAGE); void load(); });
  node("audit-next").addEventListener("click", () => { skip += PAGE; void load(); });
  // Con acceso a usuarios, se muestran nombres en lugar de identificadores.
  if (canListUsers) {
    void lab().identity.listUsers().then((users) => {
      names = new Map(users.map((user) => [user.id, `${fullName(user)} (${user.email})`]));
      void load();
    }).catch(() => undefined);
  }
  void load();
}
