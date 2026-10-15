// O dinheiro que vai para o Pipedrive e o que o Claude devolve, sem passar por float.
import { describe, expect, it } from "vitest";
import { NetDecimal } from "@/lib/calculo";
import { idDeCampo, jsonComDecimais } from "@/lib/pipedrive/cliente";
import { parseJsonExato } from "@/lib/pipedrive/json-exato";
import { lerMulta, normalizarPpid } from "@/lib/modal/extrator";

describe("jsonComDecimais", () => {
  it("escreve os NetDecimal como números exatos, com as casas", () => {
    expect(jsonComDecimais({ item_price: NetDecimal.de("22.50"), quantity: 2, nested: [NetDecimal.de("-0.10")] })).toBe(
      '{"item_price":22.50,"quantity":2,"nested":[-0.10]}',
    );
  });
  it("não mexe em textos que se pareçam com a marca", () => {
    expect(jsonComDecimais({ a: "dec:1", b: null })).toBe('{"a":"dec:1","b":null}');
  });
});

describe("idDeCampo", () => {
  const reg = (campos: Record<string, unknown>) => ({ id: 1, nome: null, campos: parseJsonExato(JSON.stringify(campos)) as Record<string, unknown> });
  it("número, {id} (v2) ou {value} (v1)", () => {
    expect(idDeCampo(reg({ pipeline_id: 3 }), "pipeline_id")).toBe(3);
    expect(idDeCampo(reg({ person_id: { id: 7 } }), "person_id")).toBe(7);
    expect(idDeCampo(reg({ org_id: { name: "X", value: 8 } }), "org_id")).toBe(8);
    expect(idDeCampo(reg({ org_id: null }), "org_id")).toBeNull();
  });
});

describe("saída do Claude", () => {
  it.each([
    ["22.50", "22.50"],
    ["22,5", "22.5"],
    ["€ 30.00", "30.00"],
    ["", "0"],
    ["-5", "0"],
    ["abc", "0"],
  ])("multa %j → %s", (entrada, esperado) => {
    expect(lerMulta(entrada).toString()).toBe(esperado);
  });
  it("PPID: só 9 dígitos passam", () => {
    expect(normalizarPpid(" 100093209 ")).toBe("100093209");
    expect(normalizarPpid("10009320")).toBeNull();
    expect(normalizarPpid("10009320A")).toBeNull();
    expect(normalizarPpid(null)).toBeNull();
  });
});
