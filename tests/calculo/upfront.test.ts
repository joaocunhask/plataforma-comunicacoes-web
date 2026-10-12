// Port de tests/.../Vodafone/UpfrontCalculatorTests.cs.
import { describe, expect, it } from "vitest";
import { calcularUpfront } from "@/lib/calculo";
import { d, dn, expectValor } from "./ajuda";

describe("calcularUpfront", () => {
  it("oráculo do negócio 6 (snapshot real, n8n): RLMC1 GOLD 24m, margem 50 → 600 / 300", () => {
    const r = calcularUpfront({
      valorUnidade: d(100),
      quantidade: 1,
      upfrontPlano: d("6.0"), // GOLD, tipo_receita=1, objetivos_atingidos=0
      ajusteDuracao: d("1.0"), // faixa 24-29 meses
      margemUpfrontPct: d(50),
    });
    expectValor(r.valorBruto, "600.00");
    expectValor(r.valorLiquido, "300.00");
  });

  it.each([
    ["100.0", 1, "6.0", "1.0", "0.0", "600.00", "600.00"], // margem 0 → líquido = bruto
    ["100.0", 1, "6.0", "1.0", "100.0", "600.00", "0.00"], // margem 100 → líquido = 0
    ["50.0", 2, "6.0", "1.0", "20.0", "600.00", "480.00"], // qtd 2 duplica; margem 20% → 80% do bruto
    ["100.0", 1, "6.0", "0.4", "50.0", "240.00", "120.00"], // duração curta (12m) reduz o bruto
    ["100.0", 1, "6.0", "1.5", "50.0", "900.00", "450.00"], // duração longa (48m) amplia o bruto
  ])("fórmula: %s × %s × %s × %s, margem %s → %s / %s", (valor, qtd, upfront, ajuste, margem, bruto, liquido) => {
    const r = calcularUpfront({
      valorUnidade: d(valor),
      quantidade: qtd,
      upfrontPlano: d(upfront),
      ajusteDuracao: d(ajuste),
      margemUpfrontPct: d(margem),
    });
    expectValor(r.valorBruto, bruto);
    expectValor(r.valorLiquido, liquido);
  });

  it("margem null: o parceiro retém tudo e o comercial não recebe (o n8n assumia 0)", () => {
    const r = calcularUpfront({
      valorUnidade: d(100),
      quantidade: 1,
      upfrontPlano: d("6.0"),
      ajusteDuracao: d("1.0"),
      margemUpfrontPct: dn(null),
    });
    expectValor(r.valorBruto, "600.00");
    expectValor(r.valorLiquido, "0.00");
  });

  it("arredonda meio para longe do zero (o mesmo do Math.round do n8n)", () => {
    // 18.78 × 1.2525 × 1.0 × 1 = 23.52195 → 23.52
    const r = calcularUpfront({
      valorUnidade: d("18.78"),
      quantidade: 1,
      upfrontPlano: d("1.0"),
      ajusteDuracao: d("1.2525"),
      margemUpfrontPct: d(0),
    });
    expect(r.valorBruto.toString()).toBe("23.52");
  });
});
