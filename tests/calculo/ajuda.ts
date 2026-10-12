import { expect } from "vitest";
import { dataCivil, NetDecimal } from "@/lib/calculo";

export const d = (valor: string | number) => NetDecimal.de(valor);
export const dn = (valor: string | number | null) => (valor === null ? null : NetDecimal.de(valor));
export const data = dataCivil;

/** Compara pelo VALOR (como o Assert.Equal de decimais no C#), mostrando o texto se falhar. */
export function expectValor(atual: NetDecimal | null | undefined, esperado: string | number | null): void {
  if (esperado === null) {
    expect(atual ?? null).toBeNull();
    return;
  }
  const texto = String(esperado);
  expect(atual == null ? atual : atual.eq(NetDecimal.de(texto)) ? texto : atual.toString()).toBe(texto);
}
