// JSON do Pipedrive sem perder dinheiro: o JSON.parse normal passa os números por float
// (49.9 fica 49.899999…), e o C# lia-os com GetDecimal, exatos e com a escala do texto.
// Aqui cada número fica como NumeroJson com o texto original (reviver com `context.source`).
import { NetDecimal } from "@/lib/calculo";

export class NumeroJson {
  constructor(readonly texto: string) {}
}

type Reviver = (this: unknown, chave: string, valor: unknown, ctx?: { source?: string }) => unknown;

export function parseJsonExato(texto: string): unknown {
  const reviver: Reviver = (_chave, valor, ctx) =>
    typeof valor === "number" && ctx?.source !== undefined ? new NumeroJson(ctx.source) : valor;
  return JSON.parse(texto, reviver as Parameters<typeof JSON.parse>[1]);
}

export type ObjetoJson = Record<string, unknown>;

export function objeto(v: unknown): ObjetoJson | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof NumeroJson) ? (v as ObjetoJson) : null;
}

/** Um inteiro de 32 bits (GetInt32/TryGetInt32): número sem casas decimais dentro do limite. */
export function inteiro(v: unknown): number | null {
  if (!(v instanceof NumeroJson) || !/^-?\d+$/.test(v.texto)) return null;
  const n = Number(v.texto);
  return n >= -2147483648 && n <= 2147483647 ? n : null;
}

/** Decimal exato (GetDecimal); expoentes não aparecem nos preços do Pipedrive e são recusados. */
export function decimal(v: unknown): NetDecimal | null {
  if (!(v instanceof NumeroJson)) return null;
  if (/[eE]/.test(v.texto)) throw new Error(`Número em notação científica no JSON do Pipedrive: ${v.texto}`);
  return NetDecimal.de(v.texto);
}

/** Texto: string tal como vem, número com o texto original (GetRawText), o resto null. */
export function texto(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v instanceof NumeroJson) return v.texto;
  return null;
}
