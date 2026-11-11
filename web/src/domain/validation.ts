import { USER_STATUSES } from "./identity";

/**
 * Reglas de formato de los datos que se crean o editan. Las comparten el
 * navegador (mensajes inmediatos y filtrado al escribir) y el servidor web
 * (la validación que no se puede saltar). El backend aplica las mismas reglas
 * en `backend/app/validators.py`.
 */
export interface Rule {
  /** Nombre del campo tal como lo ve el usuario. */
  label: string;
  max: number;
  min?: number;
  /** Prueba de formato sobre el valor ya normalizado. */
  test?: (value: string) => boolean;
  /** Explicación cuando `test` falla. */
  hint?: string;
  /** Caracteres admitidos al escribir: el navegador descarta el resto. */
  allow?: RegExp;
  /** Limpieza previa (espacios, mayúsculas…), igual en navegador y servidor. */
  normalize?: (value: string) => string;
}
export type Schema = Record<string, Rule>;

// Caracteres de control: nunca son contenido legítimo de un formulario (salto de línea y tabulador sí).
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const squash = (value: string) => value.normalize("NFC").trim().replace(/\s+/g, " ");
const trimText = (value: string) => value.normalize("NFC").trim();

const NAME = /^\p{L}+(?:[ '’-]\p{L}+)*$/u;
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
const digitCount = (value: string) => value.replace(/\D/g, "").length;

export const RULES = {
  email: {
    label: "Correo electrónico", max: 254, normalize: (v) => v.trim().toLowerCase(),
    test: (v) => EMAIL.test(v), hint: "Escribe un correo válido, por ejemplo nombre@dominio.com.",
    allow: /[A-Za-z0-9._%+@-]/,
  },
  personName: {
    label: "Nombre", min: 2, max: 100, normalize: squash,
    test: (v) => NAME.test(v), hint: "Solo admite letras, espacios, apóstrofo o guion.",
    allow: /[\p{L}\p{M} '’-]/u,
  },
  identifier: {
    label: "Identificación", max: 13, normalize: (v) => v.trim(),
    test: (v) => /^(\d{10}|\d{13})$/.test(v), hint: "Solo admite números: 10 dígitos (cédula) o 13 (RUC).",
    allow: /\d/,
  },
  phone: {
    label: "Teléfono", max: 20, normalize: squash,
    test: (v) => /^\+?[\d ()-]+$/.test(v) && digitCount(v) >= 7 && digitCount(v) <= 15,
    hint: "Solo admite números (7 a 15), con + inicial opcional y espacios, guiones o paréntesis. Ejemplo: +593 99 999 9999.",
    allow: /[\d+ ()-]/,
  },
  roleName: {
    label: "Nombre del rol", min: 2, max: 50, normalize: (v) => v.trim(),
    test: (v) => /^[A-Za-z][A-Za-z0-9_-]+$/.test(v),
    hint: "Empieza por una letra y solo admite letras sin tildes, números, guion o guion bajo. Ejemplo: PERITO_SENIOR.",
    allow: /[A-Za-z0-9_-]/,
  },
  roleDescription: { label: "Descripción", max: 500, normalize: trimText },
  status: {
    label: "Estado", max: 20, test: (v) => (USER_STATUSES as readonly string[]).includes(v),
    hint: `Debe ser uno de: ${USER_STATUSES.join(", ").toLowerCase()}.`,
  },
  password: { label: "Contraseña", max: 1024 },
  caseNumber: {
    label: "Número de caso", min: 3, max: 100, normalize: (v) => v.trim().toUpperCase(),
    test: (v) => /^[A-Z0-9]+(?:[-/.][A-Z0-9]+)*$/.test(v),
    hint: "Solo admite letras sin tildes, números y los separadores - / . (sin espacios). Ejemplo: FGE-2026-0001.",
    allow: /[A-Za-z0-9\-/.]/,
  },
  caseTitle: {
    label: "Nombre del caso", min: 3, max: 255, normalize: squash,
    test: (v) => /\p{L}/u.test(v), hint: "Debe contener texto, no solo números o símbolos.",
  },
  caseDescription: { label: "Descripción", max: 10000, normalize: trimText },
  conclusions: {
    label: "Conclusiones del perito", min: 10, max: 20000, normalize: trimText,
    test: (v) => /\p{L}/u.test(v), hint: "Deben contener texto, no solo números o símbolos.",
  },
  otpCode: {
    label: "Código de verificación", max: 8, normalize: (v) => v.replace(/\s+/g, ""),
    test: (v) => /^\d{6,8}$/.test(v), hint: "Solo admite números: los 6 dígitos de tu app de autenticación.",
    allow: /[\d ]/,
  },
  resetToken: {
    label: "Código de recuperación", max: 512, normalize: (v) => v.trim(),
    test: (v) => /^[A-Za-z0-9._~+/=-]+$/.test(v), hint: "Copia el código tal como llegó en el correo, sin espacios.",
  },
  sha256: {
    label: "Hash SHA-256", max: 64, normalize: (v) => v.trim().toLowerCase(),
    test: (v) => /^[0-9a-f]{64}$/.test(v), hint: "Son exactamente 64 caracteres hexadecimales (0-9 y a-f).",
    allow: /[0-9a-fA-F]/,
  },
  dateTime: {
    label: "Fecha", max: 40,
    test: (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v)), hint: "Usa una fecha y hora válidas.",
  },
} satisfies Record<string, Rule>;

const labelled = (rule: Rule, label: string): Rule => ({ ...rule, label });

/** Campos de cada formulario de alta o edición. */
export const USER_SCHEMA: Schema = {
  email: RULES.email, password: RULES.password, role_name: labelled(RULES.roleName, "Rol"), status: RULES.status,
  first_name: RULES.personName, last_name: labelled(RULES.personName, "Apellido"),
  identifier: RULES.identifier, phone_number: RULES.phone,
};
export const PROFILE_SCHEMA: Schema = { first_name: USER_SCHEMA.first_name, last_name: USER_SCHEMA.last_name, phone_number: RULES.phone };
export const ROLE_SCHEMA: Schema = { name: RULES.roleName, description: RULES.roleDescription };
export const CASE_SCHEMA: Schema = { case_number: RULES.caseNumber, title: RULES.caseTitle, description: RULES.caseDescription };
export const SUSPENSION_SCHEMA: Schema = {
  suspended_from: labelled(RULES.dateTime, "Inicio de la suspensión"), suspended_until: labelled(RULES.dateTime, "Fin de la suspensión"),
};

export interface Checked { value: string | null; error?: string; }

/** Normaliza y valida un valor. Vacío o null es válido salvo que el campo sea obligatorio. */
export function checkValue(rule: Rule, raw: unknown, required = false): Checked {
  if (raw === null || raw === undefined || raw === "") {
    return required ? { value: null, error: `${rule.label}: es obligatorio.` } : { value: null };
  }
  if (typeof raw !== "string") return { value: null, error: `${rule.label}: formato no válido.` };
  const value = rule.normalize ? rule.normalize(raw) : raw;
  if (!value) return required ? { value: null, error: `${rule.label}: es obligatorio.` } : { value: null };
  if (CONTROL.test(value)) return { value, error: `${rule.label}: contiene caracteres no permitidos.` };
  const length = Array.from(value).length;
  if (rule.min && length < rule.min) return { value, error: `${rule.label}: escribe al menos ${rule.min} caracteres.` };
  if (length > rule.max) return { value, error: `${rule.label}: admite como máximo ${rule.max} caracteres.` };
  if (rule.test && !rule.test(value)) return { value, error: `${rule.label}: ${rule.hint ?? "formato no válido."}` };
  return { value };
}

export interface Validation { values: Record<string, string | null>; errors: string[]; }

/**
 * Valida los campos presentes en `data` (más los obligatorios) contra el esquema.
 * Devuelve los valores ya normalizados para enviarlos tal cual.
 */
export function validateFields(data: Record<string, unknown>, schema: Schema, required: string[] = []): Validation {
  const values: Record<string, string | null> = {};
  const errors: string[] = [];
  for (const name of new Set([...Object.keys(data), ...required])) {
    const rule = schema[name];
    if (!rule) { values[name] = data[name] as string | null; continue; }
    const result = checkValue(rule, data[name], required.includes(name));
    if (result.error) errors.push(result.error);
    else if (name in data) values[name] = result.value;
  }
  return { values, errors };
}
