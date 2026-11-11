import { checkValue, type Rule, type Schema } from "@domain/validation";

type Field = HTMLInputElement | HTMLTextAreaElement;
const isTextField = (element: unknown): element is Field =>
  element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;

/** Descarta al escribir (o pegar) los caracteres que la regla no admite, conservando la posición del cursor. */
export function restrictField(field: Field, rule: Rule): void {
  field.addEventListener("input", (event) => {
    field.setCustomValidity("");
    if (!rule.allow || (event as InputEvent).isComposing) return;
    const allowed = (char: string) => rule.allow!.test(char);
    const current = field.value;
    const filtered = Array.from(current).filter(allowed).join("");
    if (filtered === current) return;
    const caret = field.selectionStart ?? current.length;
    const position = Array.from(current.slice(0, caret)).filter(allowed).join("").length;
    field.value = filtered;
    try { field.setSelectionRange(position, position); } catch { /* type=email no admite selección */ }
  });
  // Al terminar una composición (tildes con tecla muerta) se filtra lo compuesto.
  field.addEventListener("compositionend", () => field.dispatchEvent(new Event("input")));
}

/** Activa el filtrado al escribir en todos los campos del formulario que tengan regla. */
export function restrictForm(form: HTMLFormElement, schema: Schema): void {
  for (const [name, rule] of Object.entries(schema)) {
    const field = form.elements.namedItem(name);
    if (isTextField(field)) restrictField(field, rule);
  }
}

/** Mensaje sin el prefijo «Campo: » (bajo el campo ya se sabe de cuál se habla). */
const bare = (error: string) => { const text = error.slice(error.indexOf(": ") + 2); return text.charAt(0).toUpperCase() + text.slice(1); };

/**
 * Validación en vivo: al salir de un campo (y mientras se corrige) el motivo aparece
 * justo debajo, en vez del globo nativo del navegador. `validate()` revisa todo el
 * formulario antes de enviar, normaliza los valores y enfoca el primer campo inválido.
 */
export function liveValidation(form: HTMLFormElement, schema: Schema, { required = [] }: { required?: string[] } = {}): { validate: () => boolean } {
  const fields = Object.keys(schema).flatMap((name) => { const field = form.elements.namedItem(name); return isTextField(field) ? [{ name, field }] : []; });
  const check = (name: string, field: Field, show: boolean, normalize = false): boolean => {
    if (field.disabled) return true;
    const result = checkValue(schema[name], field.value, required.includes(name));
    field.setCustomValidity(result.error ?? "");
    if (!result.error && normalize && field.type !== "password") field.value = result.value ?? "";
    if (!show) return !result.error;
    const holder = field.closest(".field") ?? field.parentElement!;
    let note = holder.querySelector<HTMLElement>(".field-error");
    if (result.error) {
      if (!note) { note = document.createElement("small"); note.className = "field-error"; note.id = `${form.id}-${name}-error`; note.setAttribute("role", "alert"); holder.append(note); }
      note.textContent = bare(result.error);
      field.setAttribute("aria-invalid", "true"); field.setAttribute("aria-describedby", note.id);
    } else { note?.remove(); field.removeAttribute("aria-invalid"); field.removeAttribute("aria-describedby"); }
    return !result.error;
  };
  for (const { name, field } of fields) {
    field.addEventListener("blur", () => check(name, field, true));
    // Mientras se escribe solo se actualiza un error ya visible: no se regaña antes de terminar.
    field.addEventListener("input", () => check(name, field, field.hasAttribute("aria-invalid")));
  }
  return {
    validate() {
      const invalid = fields.filter(({ name, field }) => !check(name, field, true, true));
      invalid[0]?.field.focus();
      return invalid.length === 0;
    },
  };
}

interface FormCheck { names?: string[]; required?: string[]; }

/**
 * Valida los campos indicados (por defecto, todos los del esquema). Marca cada
 * campo inválido con su mensaje, muestra el del primero y devuelve false.
 * Los valores se reescriben ya normalizados (espacios, mayúsculas…).
 */
export function validateForm(form: HTMLFormElement, schema: Schema, { names, required = [] }: FormCheck = {}): boolean {
  let valid = true;
  for (const name of names ?? Object.keys(schema)) {
    const field = form.elements.namedItem(name);
    if (!isTextField(field) || field.disabled) continue;
    const result = checkValue(schema[name], field.value, required.includes(name));
    if (!result.error && field.type !== "password") field.value = result.value ?? "";
    field.setCustomValidity(result.error ?? "");
    if (result.error) valid = false;
  }
  if (!valid) form.reportValidity();
  return valid;
}
