import { USER_STATUSES, fullName, isLocked, isSuspended, type IdentityUser, type NewUser, type Role, type UserStatus, type UserUpdate } from "@domain/identity";
import { lab } from "../lab";
import { showToast } from "../toast";
import { describeError } from "../errors";
const node = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const field = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as HTMLInputElement;
const value = (form: HTMLFormElement, name: string) => field(form, name).value;
const statuses = USER_STATUSES;
const dateTime = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" });
let users: IdentityUser[] = [];
let roles: Role[] = [];
let pendingRole: Role | null = null;
let editing: IdentityUser | null = null;
let confirmAction: (() => Promise<void>) | null = null;
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
function show(id: string, content: string): void { const target = node(id); target.textContent = content; target.hidden = !content; }
/** Fecha ISO a valor de <input type="datetime-local"> en la hora local del navegador. */
function localInput(iso?: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function statusBadges(user: IdentityUser): HTMLElement[] {
  const badges = [text("span", user.status.toLowerCase(), `badge ${user.status === "ACTIVO" ? "badge-moss" : "badge-muted"}`)];
  if (isSuspended(user)) badges.push(text("span", "suspendido", "badge badge-alert"));
  if (isLocked(user)) badges.push(text("span", "bloqueado", "badge badge-alert"));
  if (user.mfa_enabled) badges.push(text("span", "2 pasos", "badge badge-muted"));
  return badges;
}
function renderUsers(): void {
  const query = node<HTMLInputElement>("user-search").value.toLocaleLowerCase();
  const role = node<HTMLSelectElement>("user-role-filter").value;
  const filtered = users.filter((user) => (!role || user.role.name === role) && [user.email, user.first_name, user.last_name, user.identifier].filter(Boolean).join(" ").toLocaleLowerCase().includes(query));
  const body = node("identity-users"); body.replaceChildren();
  for (const user of filtered) {
    const tr = document.createElement("tr");
    const person = document.createElement("td"); person.dataset.label = "Usuario";
    const name = fullName(user);
    const avatar = text("span", name.split(/\s+/).slice(0,2).map((part) => part[0]).join("").toUpperCase(), "avatar-small avatar-table");
    const copy = text("span", "", "user-cell-copy"); copy.append(text("strong", name), text("small", user.email));
    const identity = text("div", "", "user-cell"); identity.append(avatar, copy); person.append(identity); tr.append(person);
    const roleCell = document.createElement("td"); roleCell.dataset.label = "Rol"; roleCell.append(text("span", user.role.name, "badge badge-muted")); tr.append(roleCell);
    const status = document.createElement("td"); status.dataset.label = "Estado"; status.className = "badge-stack"; status.append(...statusBadges(user)); tr.append(status);
    const identifier = text("td", user.identifier || "—", "mono-value"); identifier.dataset.label = "Identificación"; tr.append(identifier);
    const actions = document.createElement("td"); const edit = button("Editar", () => openUser(user)); edit.setAttribute("aria-label", `Editar ${name}`); actions.append(edit); tr.append(actions); body.append(tr);
  }
  node("identity-empty").hidden = filtered.length !== 0;
  node("user-count").textContent = String(users.length);
  node("user-active-count").textContent = String(users.filter((user) => user.status === "ACTIVO" && !isSuspended(user)).length);
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
      pendingRole = role; node("delete-role-description").textContent = `Se eliminará «${role.name}». Si hay usuarios con este rol, el servicio no permitirá eliminarlo.`;
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
      // Se conserva la selección: el formulario puede estar abierto mientras se refresca la lista.
      const chosen = select.value;
      select.replaceChildren(new Option("Selecciona un rol", "")); roles.forEach((role) => select.add(new Option(role.name.replaceAll("_", " "), role.name)));
      select.value = chosen;
      node<HTMLButtonElement>("user-create").disabled = false; renderUsers();
      if (editing) { const fresh = users.find((user) => user.id === editing!.id); if (fresh) { editing = fresh; renderAccountState(fresh); } }
    } else { node<HTMLButtonElement>("role-create").disabled = false; renderRoles(); }
    message("");
  } catch (error) { message(describeError(error, "No se pudieron cargar los datos.")); }
  finally { refreshButton.disabled = false; }
}

function renderAccountState(user: IdentityUser): void {
  const facts = [
    user.last_login_at ? `Último acceso: ${dateTime.format(new Date(user.last_login_at))}.` : "Aún no ha iniciado sesión.",
    isLocked(user) ? `Bloqueada por intentos fallidos hasta ${dateTime.format(new Date(user.locked_until!))}.` : "",
    user.suspended_until && Date.parse(user.suspended_until) > Date.now() ? `Suspendida del ${dateTime.format(new Date(user.suspended_from!))} al ${dateTime.format(new Date(user.suspended_until))}.` : "",
    user.mfa_enabled ? "Verificación en dos pasos activa." : "Sin verificación en dos pasos.",
  ];
  node("user-account-state").textContent = facts.filter(Boolean).join(" ");
  node("user-unlock").hidden = !isLocked(user);
  node("user-reset-mfa").hidden = !user.mfa_enabled;
  node("user-suspend").textContent = user.suspended_until && Date.parse(user.suspended_until) > Date.now() ? "Cambiar suspensión…" : "Suspender…";
}
function openUser(user?: IdentityUser): void {
  editing = user ?? null;
  const form = node<HTMLFormElement>("identity-user-form"); form.reset();
  node("user-form-message").hidden = true; node("user-action-message").hidden = true;
  node("user-form-title").textContent = user ? "Editar usuario" : "Nuevo usuario";
  node("password-optional").textContent = "· opcional";
  node("password-hint").textContent = user ? "Déjala vacía para conservar la contraseña actual. Si la cambias, se cerrarán sus sesiones." : "Déjala vacía para enviar una invitación por correo: la persona elegirá su propia contraseña.";
  for (const key of ["id", "email", "first_name", "last_name", "identifier", "phone_number"] as const) field(form, key).value = user?.[key] ?? "";
  field(form, "role_name").value = user?.role.name ?? "";
  field(form, "status").value = user?.status ?? "ACTIVO";
  // Nadie puede cambiar su propio rol o estado, ni aplicarse acciones de administración.
  const self = !!user && user.id === lab().identity.current()?.id;
  field(form, "role_name").disabled = self; field(form, "status").disabled = self;
  node("user-account-actions").hidden = !user || self;
  if (user && !self) renderAccountState(user);
  node<HTMLDialogElement>("user-dialog").showModal();
}
function openRole(role?: Role): void {
  const form = node<HTMLFormElement>("identity-role-form"); form.reset(); node("role-form-message").hidden = true;
  field(form, "id").value = role?.id ?? ""; field(form, "name").value = role?.name ?? ""; field(form, "description").value = role?.description ?? "";
  node("role-form-title").textContent = role ? "Editar rol" : "Nuevo rol";
  node<HTMLDialogElement>("role-dialog").showModal();
}
/** Solo los campos que cambiaron: el servicio rechaza que alguien envíe su propio rol o estado aunque no cambien. */
function userChanges(form: HTMLFormElement, user: IdentityUser): UserUpdate {
  const changes: Record<string, string | null> = {};
  for (const key of ["email", "first_name", "last_name", "identifier", "phone_number"] as const) {
    const next = value(form, key).trim();
    if (next !== (user[key] ?? "")) changes[key] = next || (key === "email" ? next : null);
  }
  if (!field(form, "role_name").disabled && value(form, "role_name") !== user.role.name) changes.role_name = value(form, "role_name");
  if (!field(form, "status").disabled && value(form, "status") !== user.status) changes.status = value(form, "status");
  if (value(form, "password")) changes.password = value(form, "password");
  return changes as UserUpdate;
}
async function submit(form: HTMLFormElement, kind: "user" | "role"): Promise<void> {
  const submitButton = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const errorNode = node(`${kind}-form-message`); submitButton.disabled = true; errorNode.hidden = true;
  try {
    const id = value(form, "id");
    if (kind === "user") {
      if (id && editing) {
        const changes = userChanges(form, editing);
        if (!Object.keys(changes).length) { closeDialog(node<HTMLDialogElement>("user-dialog")); showToast("Sin cambios."); return; }
        await lab().identity.updateUser(id, changes);
        if (id === lab().identity.current()?.id) { window.location.assign("/app"); return; }
      } else {
        const created: NewUser = { email: value(form, "email").trim(), role_name: value(form, "role_name"), status: value(form, "status") as UserStatus };
        for (const key of ["first_name", "last_name", "identifier", "phone_number"] as const) if (value(form, key).trim()) created[key] = value(form, key).trim();
        if (value(form, "password")) created.password = value(form, "password");
        await lab().identity.createUser(created);
        if (!created.password) showToast(`Invitación enviada a ${created.email}.`);
      }
    } else await lab().identity.saveRole({ name: value(form, "name").trim(), description: value(form, "description").trim() }, id || undefined);
    closeDialog(node<HTMLDialogElement>(`${kind}-dialog`)); showToast("Cambios guardados."); await refresh();
  } catch (error) { errorNode.textContent = describeError(error, "No se pudo guardar."); errorNode.hidden = false; }
  finally { submitButton.disabled = false; if (kind === "user") field(form, "password").value = ""; }
}

/** Ejecuta una acción de administración sobre el usuario abierto y refresca la lista. */
async function accountAction(run: (user: IdentityUser) => Promise<unknown>, done: string): Promise<void> {
  if (!editing) return;
  show("user-action-message", "");
  try { await run(editing); showToast(done); await refresh(); }
  catch (error) { show("user-action-message", describeError(error, "No se pudo completar la acción.")); }
}
function confirm(title: string, description: string, accept: string, run: () => Promise<void>): void {
  node("confirm-title").textContent = title; node("confirm-description").textContent = description;
  node("confirm-accept").textContent = accept; show("confirm-message", "");
  confirmAction = run; node<HTMLDialogElement>("confirm-dialog").showModal();
}
function wireAccountActions(): void {
  node("user-unlock").addEventListener("click", () => void accountAction((user) => lab().identity.unlockUser(user.id), "Cuenta desbloqueada."));
  node("user-revoke-sessions").addEventListener("click", () => confirm("Cerrar sesiones", "La persona tendrá que volver a iniciar sesión en todos sus dispositivos.", "Cerrar sesiones",
    () => accountAction((user) => lab().identity.revokeUserSessions(user.id), "Sesiones cerradas.")));
  node("user-reset-mfa").addEventListener("click", () => confirm("Restablecer verificación en dos pasos", "Se desactivará su verificación en dos pasos y se cerrarán sus sesiones. Podrá volver a configurarla desde Seguridad.", "Restablecer",
    () => accountAction((user) => lab().identity.resetUserMfa(user.id), "Verificación en dos pasos restablecida.")));
  node("user-delete").addEventListener("click", () => confirm("Eliminar usuario", `Se eliminará la cuenta de ${editing ? fullName(editing) : "este usuario"} de forma permanente. Si solo quieres impedir el acceso, cambia su estado a inactivo.`, "Eliminar",
    async () => {
      if (!editing) return;
      await lab().identity.deleteUser(editing.id);
      closeDialog(node<HTMLDialogElement>("user-dialog")); editing = null; showToast("Usuario eliminado."); await refresh();
    }));
  node("confirm-accept").addEventListener("click", async () => {
    if (!confirmAction) return;
    const accept = node<HTMLButtonElement>("confirm-accept"); accept.disabled = true;
    try { await confirmAction(); closeDialog(node<HTMLDialogElement>("confirm-dialog")); confirmAction = null; }
    catch (error) { show("confirm-message", describeError(error, "No se pudo completar la acción.")); }
    finally { accept.disabled = false; }
  });
  const suspendForm = node<HTMLFormElement>("suspend-form");
  node("user-suspend").addEventListener("click", () => {
    if (!editing) return;
    suspendForm.reset(); show("suspend-message", "");
    const active = !!editing.suspended_until && Date.parse(editing.suspended_until) > Date.now();
    field(suspendForm, "from").value = active ? localInput(editing.suspended_from) : localInput(new Date().toISOString());
    field(suspendForm, "until").value = active ? localInput(editing.suspended_until) : "";
    node("suspend-lift").hidden = !active;
    node<HTMLDialogElement>("suspend-dialog").showModal();
  });
  suspendForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const from = new Date(value(suspendForm, "from")), until = new Date(value(suspendForm, "until"));
    if (!(until > from)) { show("suspend-message", "La fecha final debe ser posterior a la inicial."); return; }
    if (until.getTime() <= Date.now()) { show("suspend-message", "La fecha final ya pasó."); return; }
    try {
      await lab().identity.suspendUser(editing!.id, from.toISOString(), until.toISOString());
      closeDialog(node<HTMLDialogElement>("suspend-dialog")); showToast("Suspensión guardada."); await refresh();
    } catch (error) { show("suspend-message", describeError(error, "No se pudo suspender.")); }
  });
  node("suspend-lift").addEventListener("click", async () => {
    try {
      await lab().identity.suspendUser(editing!.id, null, null);
      closeDialog(node<HTMLDialogElement>("suspend-dialog")); showToast("Suspensión levantada."); await refresh();
    } catch (error) { show("suspend-message", describeError(error, "No se pudo levantar la suspensión.")); }
  });
}

export function wireIdentity(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-close]").forEach((closer) => closer.addEventListener("click", () => closeDialog(node<HTMLDialogElement>(closer.dataset.close!))));
  document.querySelectorAll<HTMLDialogElement>("dialog").forEach((dialog) => dialog.addEventListener("close", () => dialog.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((input) => input.value = "")));
  node("identity-refresh").addEventListener("click", () => void refresh());
  if (section() === "usuarios") {
    node<HTMLButtonElement>("user-create").disabled = true;
    node("user-create").addEventListener("click", () => openUser());
    const select = field(node<HTMLFormElement>("identity-user-form"), "status") as unknown as HTMLSelectElement;
    statuses.forEach((status) => select.add(new Option(status.toLowerCase(), status)));
    node("user-search").addEventListener("input", renderUsers); node("user-role-filter").addEventListener("change", renderUsers);
    node<HTMLFormElement>("identity-user-form").addEventListener("submit", (event) => { event.preventDefault(); void submit(event.currentTarget as HTMLFormElement, "user"); });
    node<HTMLDialogElement>("user-dialog").addEventListener("close", () => { editing = null; });
    wireAccountActions();
  } else {
    node<HTMLButtonElement>("role-create").disabled = true;
    node("role-create").addEventListener("click", () => openRole()); node("role-search").addEventListener("input", renderRoles);
    node<HTMLFormElement>("identity-role-form").addEventListener("submit", (event) => { event.preventDefault(); void submit(event.currentTarget as HTMLFormElement, "role"); });
    node("delete-role-confirm").addEventListener("click", async () => {
      if (!pendingRole) return;
      const confirmButton = node<HTMLButtonElement>("delete-role-confirm"); confirmButton.disabled = true;
      try { await lab().identity.deleteRole(pendingRole.id); closeDialog(node<HTMLDialogElement>("delete-role-dialog")); pendingRole = null; showToast("Rol eliminado."); await refresh(); }
      catch (error) { node("delete-role-message").textContent = describeError(error, "No se pudo eliminar."); node("delete-role-message").hidden = false; }
      finally { confirmButton.disabled = false; }
    });
    const tabs = [node("tab-roles"), node("tab-permissions")];
    const activate = (index: number) => tabs.forEach((tab, i) => { tab.setAttribute("aria-selected", String(i === index)); tab.tabIndex = i === index ? 0 : -1; node(tab.getAttribute("aria-controls")!).hidden = i !== index; });
    tabs.forEach((tab, index) => { tab.addEventListener("click", () => activate(index)); tab.addEventListener("keydown", (event) => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); const next = 1 - index; activate(next); tabs[next].focus(); } }); });
  }
  void refresh();
}
