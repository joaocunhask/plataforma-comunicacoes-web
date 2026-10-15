// Port de tests/.../Pipedrive/SubscricaoExpanderTests.cs.
import { describe, expect, it } from "vitest";
import { expandir } from "@/lib/modal/subscricoes";

describe("expandir", () => {
  it("com números gera uma subscrição por número, quantidade 1", () => {
    const subs = expandir(["911111111", "922222222", "933333333"], 1, 24);

    expect(subs).toHaveLength(3);
    expect(subs.map((s) => s.numero)).toEqual(["911111111", "922222222", "933333333"]);
    for (const s of subs) expect(s.duracaoMeses).toBe(24);
    for (const s of subs) expect(s.quantidade).toBe(1); // cada número = 1 contrato
  });

  it("com números ignora a quantidade passada", () => {
    // O nº de números manda — mesmo que a quantidade diga outra coisa.
    const subs = expandir(["911", "922"], 20, 12);
    expect(subs).toHaveLength(2);
  });

  it("sem números gera UMA subscrição com quantidade N", () => {
    // Sem números → 1 subscrição a cobrir toda a quantidade (cálculo no total).
    const subs = expandir(null, 20, 30);

    expect(subs).toHaveLength(1);
    expect(subs[0].numero).toBeNull();
    expect(subs[0].quantidade).toBe(20);
    expect(subs[0].duracaoMeses).toBe(30);
  });

  it("sem números e quantidade zero gera uma com quantidade 1", () => {
    const subs = expandir([], 0, 12);
    expect(subs).toHaveLength(1);
    expect(subs[0].numero).toBeNull();
    expect(subs[0].quantidade).toBe(1);
  });

  it("números vazios ou em branco são ignorados", () => {
    const subs = expandir(["911111111", "  ", ""], 1, 24);
    expect(subs).toHaveLength(1);
    expect(subs[0].numero).toBe("911111111");
    expect(subs[0].quantidade).toBe(1);
  });
});
