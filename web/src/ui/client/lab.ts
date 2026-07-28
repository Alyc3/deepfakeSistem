/**
 * Interfaz — Puerta a los casos de uso.
 *
 * La interfaz nunca importa un adaptador: pide el laboratorio ya montado a
 * la raíz de composición y usa exclusivamente casos de uso.
 */
import { createLab, type Lab } from "@infrastructure/container";

let instance: Lab | null = null;

export const lab = (): Lab => (instance ??= createLab());
