import { USER_STATUSES, type IdentityUser, type NewUser, type Role, type UserStatus } from "@domain/identity";
import { lab } from "../lab";
import { showToast } from "../toast";
const node = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const field = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as HTMLInputElement;
const value = (form: HTMLFormElement, name: string) => field(form, name).value;
const statuses = USER_STATUSES;
let users: IdentityUser[] = [];
let roles: Role[] = [];
let pendingRole: Role | null = null;
let generation = 0;
const section = () => document.body.dataset.section;
function text(tag: string, content: string, className = ""): HTMLElement {
  const element = document.createElement(tag); element.textContent = content; element.className = className; return element;
}
function button(label: string, run: () => void, className = "text-action"): HTMLButtonElement {
  const element = document.createElement("button"); element.type = "button"; element.textContent = label; element.className = className; element.addEventListener("click", run); return element;
}
function closeDialog(dialog: HTMLDialogElement): void {
  dialog.close();
  dialog.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((input) => input.value = "");
}
function message(content: string): void { node("identity-message").textContent = content; }
function renderUsers(): void {
  const query = node<HTMLInputElement>("user-search").value.toLocaleLowerCase();
  const role = node<HTMLSelectElement>("user-role-filter").value;
  const filtered = users.filter((user) => (!role || user.role.name === role) && [user.email, user.first_name, user.last_name, user.identifier].filter(Boolean).join(" ").toLocaleLowerCase().includes(query));
  const body = node("identity-users"); body.replaceChildren();
  for (const user of filtered) {
    const tr = document.createElement("tr");
    const person = document.createElement("td"); person.dataset.label = "Usuario";
    const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email;
    const avatar = text("span", fullName.split(/\s+/).slice(0,2).map((name) => name[0]).join("").toUpperCase(), "avatar-small avatar-table");
    const copy = text("span", "", "user-cell-copy"); copy.append(text("strong", fullName), text("small", user.email));
    const identity = text("div", "", "user-cell"); identity.append(avatar, copy); person.append(identity); tr.append(person);
    const roleCell = document.createElement("td"); roleCell.dataset.label = "Rol"; roleCell.append(text("span", user.role.name, "badge badge-muted")); tr.append(roleCell);
    const status = document.createElement("td"); status.dataset.label = "Estado"; status.append(text("span", user.status.toLowerCase(), `badge ${user.status === "ACTIVO" ? "badge-moss" : "badge-muted"}`)); tr.append(status);
    const identifier = text("td", user.identifier || "—", "mono-value"); identifier.dataset.label = "Identificación"; tr.append(identifier);
    const actions = document.createElement("td"); const edit = button("Editar", () => openUser(user)); edit.setAttribute("aria-label", `Editar ${fullName}`); actions.append(edit); tr.append(actions); body.append(tr);
  }
  node("identity-empty").hidden = filtered.length !== 0;
  node("user-count").textContent = String(users.length);
  node("user-active-count").textContent = String(users.filter((user) => user.status === "ACTIVO").length);
  node("user-role-count").textContent = String(new Set(users.map((user) => user.role.id)).size);
  node("user-visible-count").textContent = `${filtered.length} de ${users.length} usuarios`;
}
function renderRoles(): void {
  const query = node<HTMLInputElement>("role-search").value.toLocaleLowerCase();
  const list = roles.filter((role) => `${role.name} ${role.description || ""}`.toLocaleLowerCase().includes(query));
  const container = node("identity-roles"); container.replaceChildren();
  for (const role of list) {
    const card = text("article", "", "surface role-card");
    const heading = text("div", "", "role-card-top"); heading.append(text("span", role.name.slice(0,2).toUpperCase(), "role-monogram"), text("span", "Rol del servicio", "mono-label"));
    const footer = text("div", "", "role-card-actions");
    footer.append(button("Editar rol", () => openRole(role)), button("Eliminar", () => {
      pendingRole = role; node("delete-role-description").textContent = `Se eliminará «${role.name}». Los roles con usuarios asociados se conservan.`;
      node("delete-role-message").hidden = true; node<HTMLDialogElement>("delete-role-dialog").showModal();
    }, "text-action danger-action"));
    card.append(heading, text("h2", role.name.replaceAll("_", " ")), text("p", role.description || "Sin descripción.", "role-description"), footer); container.append(card);
  }
  node("identity-empty").hidden = list.length !== 0;
}
async function refresh(): Promise<void> {
  const request = ++generation; message("Actualizando…");
  const refreshButton = node<HTMLButtonElement>("identity-refresh"); refreshButton.disabled = true;
  try {
    const result = await Promise.all([lab().identity.listRoles(), section() === "usuarios" ? lab().identity.listUsers() : Promise.resolve([])]);
    if (request !== generation) return;
    roles = result[0].sort((a,b) => a.name.localeCompare(b.name)); users = result[1];
    if (section() === "usuarios") {
      const filter = node<HTMLSelectElement>("user-role-filter"); const selected = filter.value;
      filter.replaceChildren(new Option("Todos los roles", ""));
      roles.forEach((role) => filter.add(new Option(role.name.replaceAll("_", " "), role.name))); filter.value = selected;
      const select = field(node<HTMLFormElement>("identity-user-form"), "role_name") as unknown as HTMLSelectElement;
      select.replaceChildren(new Option("Selecciona un rol", "")); roles.forEach((role) => select.add(new Option(role.name.replaceAll("_", " "), role.name)));
      node<HTMLButtonElement>("user-create").disabled = false; renderUsers();
    } else { node<HTMLButtonElement>("role-create").disabled = false; renderRoles(); }
    message("");
  } catch (error) { message(error instanceof Error ? error.message : "No se pudieron cargar los datos."); }
  finally { refreshButton.disabled = false; }
}
function openUser(user?: IdentityUser): void {
  const form = node<HTMLFormElement>("identity-user-form"); form.reset();
  node("user-form-message").hidden = true;
  node("user-form-title").textContent = user ? "Editar usuario" : "Nuevo usuario";
  node("password-optional").textContent = user ? "· opcional" : "";
  field(form, "password").required = !user;
  for (const key of ["id", "email", "first_name", "last_name", "identifier", "phone_number"] as const) field(form, key).value = user?.[key] ?? "";
  field(form, "first_name").disabled = !!user; field(form, "last_name").disabled = !!user;
  field(form, "role_name").value = user?.role.name ?? "";
  field(form, "status").value = user?.status ?? "ACTIVO";
  node<HTMLDialogElement>("user-dialog").showModal();
}
function openRole(role?: Role): void {
  const form = node<HTMLFormElement>("identity-role-form"); form.reset(); node("role-form-message").hidden = true;
  field(form, "id").value = role?.id ?? ""; field(form, "name").value = role?.name ?? ""; field(form, "description").value = role?.description ?? "";
  node("role-form-title").textContent = role ? "Editar rol" : "Nuevo rol";
  node<HTMLDialogElement>("role-dialog").showModal();
}
async function submit(form: HTMLFormElement, kind: "user" | "role"): Promise<void> {
  const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const errorNode = node(`${kind}-form-message`); submit.disabled = true; errorNode.hidden = true;
  try {
    const id = value(form, "id");
    if (kind === "user") {
      const common = { email: value(form, "email").trim(), role_name: value(form, "role_name"), status: value(form, "status") as UserStatus, identifier: value(form, "identifier"), phone_number: value(form, "phone_number"), ...(value(form, "password") ? { password: value(form, "password") } : {}) };
      if (id) await lab().identity.updateUser(id, common);
      else await lab().identity.createUser({ ...common, password: value(form, "password"), first_name: value(form, "first_name"), last_name: value(form, "last_name") } as NewUser);
      if (id === lab().identity.current()?.id) { window.location.assign("/app"); return; }
    } else await lab().identity.saveRole({ name: value(form, "name").trim(), description: value(form, "description").trim() }, id || undefined);
    closeDialog(node<HTMLDialogElement>(`${kind}-dialog`)); showToast("Cambios guardados."); await refresh();
  } catch (error) { errorNode.textContent = error instanceof Error ? error.message : "No se pudo guardar."; errorNode.hidden = false; }
  finally { submit.disabled = false; if (kind === "user") field(form, "password").value = ""; }
}
export function wireIdentity(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-close]").forEach((button) => button.addEventListener("click", () => closeDialog(node<HTMLDialogElement>(button.dataset.close!))));
  document.querySelectorAll<HTMLDialogElement>("dialog").forEach((dialog) => dialog.addEventListener("close", () => dialog.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((input) => input.value = "")));
  node("identity-refresh").addEventListener("click", () => void refresh());
  if (section() === "usuarios") {
    node<HTMLButtonElement>("user-create").disabled = true;
    node("user-create").addEventListener("click", () => openUser());
    const select = field(node<HTMLFormElement>("identity-user-form"), "status") as unknown as HTMLSelectElement;
    statuses.forEach((status) => select.add(new Option(status.toLowerCase(), status)));
    node("user-search").addEventListener("input", renderUsers); node("user-role-filter").addEventListener("change", renderUsers);
    node<HTMLFormElement>("identity-user-form").addEventListener("submit", (event) => { event.preventDefault(); void submit(event.currentTarget as HTMLFormElement, "user"); });
  } else {
    node<HTMLButtonElement>("role-create").disabled = true;
    node("role-create").addEventListener("click", () => openRole()); node("role-search").addEventListener("input", renderRoles);
    node<HTMLFormElement>("identity-role-form").addEventListener("submit", (event) => { event.preventDefault(); void submit(event.currentTarget as HTMLFormElement, "role"); });
    node("delete-role-confirm").addEventListener("click", async () => {
      if (!pendingRole) return;
      const button = node<HTMLButtonElement>("delete-role-confirm"); button.disabled = true;
      try { await lab().identity.deleteRole(pendingRole.id); closeDialog(node<HTMLDialogElement>("delete-role-dialog")); pendingRole = null; showToast("Rol eliminado."); await refresh(); }
      catch (error) { node("delete-role-message").textContent = error instanceof Error ? error.message : "No se pudo eliminar."; node("delete-role-message").hidden = false; }
      finally { button.disabled = false; }
    });
    const tabs = [node("tab-roles"), node("tab-permissions")];
    const activate = (index: number) => tabs.forEach((tab, i) => { tab.setAttribute("aria-selected", String(i === index)); tab.tabIndex = i === index ? 0 : -1; node(tab.getAttribute("aria-controls")!).hidden = i !== index; });
    tabs.forEach((tab, index) => { tab.addEventListener("click", () => activate(index)); tab.addEventListener("keydown", (event) => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); const next = 1 - index; activate(next); tabs[next].focus(); } }); });
  }
  void refresh();
}
